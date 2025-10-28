import React, { useState, useMemo } from 'react';
import { Upload, Download, Settings, TrendingUp, Users, Award } from 'lucide-react';
import * as XLSX from 'xlsx';

const DEFAULT_WEIGHTS = { TR: 0.75, CR: 0.75, TN: 1, CM: 0.25 };
const DEFAULT_DELTA_CAPS = { TN: 300, CR: 225, TR: null, CM: 150 };
const DEFAULT_BASE_K = 36;
const DEFAULT_START_RATING = 1500;
const DEFAULT_USE_MOV = true;
const DEFAULT_DELTA_CAP_START_ROUND = 2;

function expectedScore(r_i, r_j, cap = 300) {
  let diff = r_j - r_i;
  if (diff > cap) diff = cap;
  else if (diff < -cap) diff = -cap;
  return 1.0 / (1.0 + Math.pow(10, (r_j - r_i) / 400.0));
}

function movMultiplier(margin, ratingDiff) {
  if (margin <= 0) return 1.0;
  return Math.log(1 + margin) * (2.2 / (0.001 * Math.abs(ratingDiff) + 2.2));
}

function roundTypeFromId(roundId, weights) {
  if (!roundId || typeof roundId !== 'string') return 'TR';
  const token = roundId.split('-')[0].trim().split(' ')[0];
  return weights[token] ? token : 'TR';
}

function computeEloRatings(data, config) {
  const { BASE_K, START_RATING, USE_MOV, DELTA_CAP_START_ROUND, WEIGHTS, DELTA_CAPS } = config;
  
  const ratings = {};
  const historyRows = [];
  const snapshots = [];
  const scalingRecords = [];
  let roundCounter = 0;

  const rounds = {};
  data.forEach(row => {
    if (!rounds[row.round_seq]) rounds[row.round_seq] = [];
    rounds[row.round_seq].push(row);
  });

  const sortedSeqs = Object.keys(rounds).map(Number).sort((a, b) => a - b);

  sortedSeqs.forEach(seq => {
    roundCounter++;
    const group = rounds[seq];
    const players = group.map(r => r.Name);
    const scores = group.map(r => r.score);
    const roundId = group[0].round_id;
    const rtype = roundTypeFromId(roundId, WEIGHTS);
    const kRound = BASE_K * (WEIGHTS[rtype] || 1.0);

    players.forEach(p => {
      if (ratings[p] === undefined) ratings[p] = START_RATING;
    });

    const n = players.length;
    if (n <= 1) {
      players.forEach(p => {
        historyRows.push({
          round_seq: seq,
          round_id: roundId,
          round_type: rtype,
          player: p,
          score: group.find(r => r.Name === p).score,
          rating_pre: ratings[p],
          rating_post: ratings[p],
          delta: 0,
          K_effective: 0
        });
      });
      
      const snap = Object.entries(ratings)
        .map(([player, rating]) => ({ player, rating, round_seq: seq, round_id: roundId, round_type: rtype }))
        .sort((a, b) => b.rating - a.rating);
      snapshots.push(...snap);
      return;
    }

    const R = players.map(p => ratings[p]);
    const S = new Array(n).fill(0);
    const E = new Array(n).fill(0);
    const W_total = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        
        const e_ij = expectedScore(R[i], R[j]);
        E[i] += e_ij;

        let s_ij, margin;
        if (scores[i] < scores[j]) {
          s_ij = 1.0;
          margin = scores[j] - scores[i];
        } else if (scores[i] > scores[j]) {
          s_ij = 0.0;
          margin = (scores[i] - scores[j]) * -1.0;
        } else {
          s_ij = 0.5;
          margin = 0.0;
        }
        S[i] += s_ij;

        const w_ij = USE_MOV ? movMultiplier(Math.max(0, margin), R[i] - R[j]) : 1.0;
        W_total[i] += w_ij;
      }
    }

    const deltas = new Array(n);
    const deltasOriginal = new Array(n);
    
    for (let i = 0; i < n; i++) {
      const mov_w = USE_MOV && (n - 1) > 0 ? W_total[i] / (n - 1) : 1.0;
      deltas[i] = kRound * mov_w * (S[i] - E[i]);
      deltasOriginal[i] = deltas[i];
    }

    let scaleFactor = 1.0;
    if (roundCounter >= DELTA_CAP_START_ROUND) {
      const deltaCap = DELTA_CAPS[rtype] !== undefined ? DELTA_CAPS[rtype] : 300;
      
      if (deltaCap !== null) {
        const maxAbsDelta = Math.max(...deltas.map(Math.abs));
        if (maxAbsDelta > deltaCap) {
          scaleFactor = deltaCap / maxAbsDelta;
          for (let i = 0; i < n; i++) {
            deltas[i] = deltas[i] * scaleFactor;
          }

          for (let i = 0; i < n; i++) {
            scalingRecords.push({
              round_seq: seq,
              round_id: roundId,
              round_type: rtype,
              player: players[i],
              score: scores[i],
              delta_original: deltasOriginal[i],
              delta_scaled: deltas[i],
              reduction: deltasOriginal[i] - deltas[i],
              scale_factor: scaleFactor,
              max_abs_delta_original: maxAbsDelta,
              delta_cap: deltaCap
            });
          }
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const pre = ratings[players[i]];
      const post = pre + deltas[i];
      ratings[players[i]] = post;
      
      historyRows.push({
        round_seq: seq,
        round_id: roundId,
        round_type: rtype,
        player: players[i],
        score: scores[i],
        rating_pre: pre,
        rating_post: post,
        delta: deltas[i],
        K_effective: kRound
      });
    }

    const snap = Object.entries(ratings)
      .map(([player, rating]) => ({ player, rating, round_seq: seq, round_id: roundId, round_type: rtype }))
      .sort((a, b) => b.rating - a.rating);
    snapshots.push(...snap);
  });

  const finalRatings = Object.entries(ratings)
    .map(([player, rating]) => ({ player, rating }))
    .sort((a, b) => b.rating - a.rating);

  return { finalRatings, history: historyRows, snapshots, scalingRecords };
}

export default function DiscGolfElo() {
  const [data, setData] = useState(null);
  const [results, setResults] = useState(null);
  const [activeTab, setActiveTab] = useState('upload');
  const [showSettings, setShowSettings] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);
  
  // Configuration state
  const [config, setConfig] = useState({
    BASE_K: DEFAULT_BASE_K,
    START_RATING: DEFAULT_START_RATING,
    USE_MOV: DEFAULT_USE_MOV,
    DELTA_CAP_START_ROUND: DEFAULT_DELTA_CAP_START_ROUND,
    WEIGHTS: { ...DEFAULT_WEIGHTS },
    DELTA_CAPS: { ...DEFAULT_DELTA_CAPS }
  });

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setProcessing(true);
    setError(null);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const wb = XLSX.read(evt.target.result, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const jsonData = XLSX.utils.sheet_to_json(ws);

        console.log('Raw data:', jsonData);

        // Transform to long format
        const longData = [];
        const roundIds = Object.keys(jsonData[0]).filter(k => k !== 'Name' && !k.toLowerCase().startsWith('unnamed'));
        
        console.log('Round IDs:', roundIds);

        jsonData.forEach(row => {
          const playerName = row.Name || row.name || row.Player || row.player;
          if (!playerName) {
            console.warn('Row missing player name:', row);
            return;
          }
          
          roundIds.forEach((roundId, idx) => {
            const score = row[roundId];
            if (score !== null && score !== undefined && score !== '' && !isNaN(score)) {
              longData.push({
                Name: String(playerName).trim(),
                round_id: String(roundId).trim(),
                score: Number(score),
                round_seq: idx
              });
            }
          });
        });

        console.log('Transformed data:', longData);

        if (longData.length === 0) {
          setError('No valid data found in the file. Make sure you have a "Name" column and score columns.');
          setProcessing(false);
          return;
        }

        setData(longData);
        
        try {
          const computed = computeEloRatings(longData, config);
          console.log('Computed results:', computed);
          setResults(computed);
          setActiveTab('rankings');
        } catch (error) {
          console.error('Error computing ratings:', error);
          setError('Error computing ratings: ' + error.message);
        }
      } catch (error) {
        console.error('Error processing file:', error);
        setError('Error processing file: ' + error.message);
      } finally {
        setProcessing(false);
      }
    };
    reader.readAsBinaryString(file);
  };

  const downloadExcel = () => {
    if (!results) return;

    const wb = XLSX.utils.book_new();
    
    // final ratings
    const ws1 = XLSX.utils.json_to_sheet(results.finalRatings);
    XLSX.utils.book_append_sheet(wb, ws1, 'Final Ratings');
    
    // hitsory
    const ws2 = XLSX.utils.json_to_sheet(results.history);
    XLSX.utils.book_append_sheet(wb, ws2, 'History');
    
    // snapshots
    const ws3 = XLSX.utils.json_to_sheet(results.snapshots);
    XLSX.utils.book_append_sheet(wb, ws3, 'Snapshots');
    
    // scaling details
    if (results.scalingRecords.length > 0) {
      const ws4 = XLSX.utils.json_to_sheet(results.scalingRecords);
      XLSX.utils.book_append_sheet(wb, ws4, 'Scaling Details');
    }

    XLSX.writeFile(wb, 'disc_golf_elo_results.xlsx');
  };

  const recomputeWithNewConfig = () => {
    if (!data) return;
    setProcessing(true);
    setError(null);
    
    try {
      const computed = computeEloRatings(data, config);
      setResults(computed);
      setActiveTab('rankings');
    } catch (error) {
      console.error('Error recomputing ratings:', error);
      setError('Error recomputing ratings: ' + error.message);
    } finally {
      setProcessing(false);
    }
  };

  const resetToDefaults = () => {
    setConfig({
      BASE_K: DEFAULT_BASE_K,
      START_RATING: DEFAULT_START_RATING,
      USE_MOV: DEFAULT_USE_MOV,
      DELTA_CAP_START_ROUND: DEFAULT_DELTA_CAP_START_ROUND,
      WEIGHTS: { ...DEFAULT_WEIGHTS },
      DELTA_CAPS: { ...DEFAULT_DELTA_CAPS }
    });
  };

  const uniqueRounds = useMemo(() => {
    if (!results) return [];
    const rounds = [...new Set(results.snapshots.map(s => s.round_id))];
    return rounds;
  }, [results]);

  const [selectedRound, setSelectedRound] = useState(null);

  const currentSnapshot = useMemo(() => {
    if (!results || !selectedRound) return results?.finalRatings || [];
    return results.snapshots
      .filter(s => s.round_id === selectedRound)
      .sort((a, b) => b.rating - a.rating);
  }, [results, selectedRound]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Award className="w-10 h-10 text-indigo-600" />
              <div>
                <h1 className="text-3xl font-bold text-gray-800">Disc Golf ELO Calculator</h1>
                <p className="text-gray-600">Multi-player rating system with margin of victory</p>
              </div>
            </div>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Settings className="w-6 h-6 text-gray-600" />
            </button>
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
            <h3 className="text-xl font-bold mb-4">Algorithm Settings</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <strong>Base K:</strong> {config.BASE_K}
              </div>
              <div>
                <strong>Start Rating:</strong> {config.START_RATING}
              </div>
              <div>
                <strong>Use MOV:</strong> {config.USE_MOV ? 'Yes' : 'No'}
              </div>
              <div>
                <strong>Cap From Round:</strong> {config.DELTA_CAP_START_ROUND}
              </div>
            </div>
            <div className="mt-4">
              <strong className="block mb-2">Round Type Weights:</strong>
              <div className="flex gap-4 text-sm">
                {Object.entries(config.WEIGHTS).map(([type, weight]) => (
                  <span key={type} className="bg-gray-100 px-3 py-1 rounded">
                    {type}: {weight}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="bg-white rounded-lg shadow-lg mb-6">
          <div className="flex border-b">
            <button
              onClick={() => setActiveTab('upload')}
              className={`flex-1 py-3 px-4 font-semibold transition-colors ${
                activeTab === 'upload'
                  ? 'border-b-2 border-indigo-600 text-indigo-600'
                  : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              <Upload className="w-5 h-5 inline mr-2" />
              Upload Data
            </button>
            <button
              onClick={() => setActiveTab('config')}
              className={`flex-1 py-3 px-4 font-semibold transition-colors ${
                activeTab === 'config'
                  ? 'border-b-2 border-indigo-600 text-indigo-600'
                  : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              <Settings className="w-5 h-5 inline mr-2" />
              Configuration
            </button>
            <button
              onClick={() => setActiveTab('rankings')}
              disabled={!results}
              className={`flex-1 py-3 px-4 font-semibold transition-colors ${
                activeTab === 'rankings'
                  ? 'border-b-2 border-indigo-600 text-indigo-600'
                  : 'text-gray-600 hover:text-gray-800 disabled:text-gray-400'
              }`}
            >
              <TrendingUp className="w-5 h-5 inline mr-2" />
              Rankings
            </button>
            <button
              onClick={() => setActiveTab('history')}
              disabled={!results}
              className={`flex-1 py-3 px-4 font-semibold transition-colors ${
                activeTab === 'history'
                  ? 'border-b-2 border-indigo-600 text-indigo-600'
                  : 'text-gray-600 hover:text-gray-800 disabled:text-gray-400'
              }`}
            >
              <Users className="w-5 h-5 inline mr-2" />
              History
            </button>
          </div>

          <div className="p-6">
            {/* Configuration Tab */}
            {activeTab === 'config' && (
              <div className="max-w-4xl mx-auto">
                <div className="flex justify-between items-center mb-6">
                  <h2 className="text-2xl font-bold">Algorithm Configuration</h2>
                  <button
                    onClick={resetToDefaults}
                    className="px-4 py-2 text-sm bg-gray-200 hover:bg-gray-300 rounded-lg transition-colors"
                  >
                    Reset to Defaults
                  </button>
                </div>

                {/* Basic Settings */}
                <div className="bg-gray-50 rounded-lg p-6 mb-6">
                  <h3 className="text-lg font-semibold mb-4">Basic Settings</h3>
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-medium mb-2">Base K Factor</label>
                      <input
                        type="number"
                        value={config.BASE_K}
                        onChange={(e) => setConfig({...config, BASE_K: Number(e.target.value)})}
                        className="w-full border rounded-lg px-4 py-2"
                      />
                      <p className="text-xs text-gray-600 mt-1">Determines how much ratings change per game</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">Starting Rating</label>
                      <input
                        type="number"
                        value={config.START_RATING}
                        onChange={(e) => setConfig({...config, START_RATING: Number(e.target.value)})}
                        className="w-full border rounded-lg px-4 py-2"
                      />
                      <p className="text-xs text-gray-600 mt-1">Initial rating for new players</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">Use Margin of Victory</label>
                      <select
                        value={config.USE_MOV ? 'true' : 'false'}
                        onChange={(e) => setConfig({...config, USE_MOV: e.target.value === 'true'})}
                        className="w-full border rounded-lg px-4 py-2"
                      >
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                      <p className="text-xs text-gray-600 mt-1">Scale rating changes by score difference</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">Apply Delta Cap From Round</label>
                      <input
                        type="number"
                        value={config.DELTA_CAP_START_ROUND}
                        onChange={(e) => setConfig({...config, DELTA_CAP_START_ROUND: Number(e.target.value)})}
                        className="w-full border rounded-lg px-4 py-2"
                      />
                      <p className="text-xs text-gray-600 mt-1">Start capping rating changes after this round</p>
                    </div>
                  </div>
                </div>

                {/* Round Type Weights */}
                <div className="bg-gray-50 rounded-lg p-6 mb-6">
                  <h3 className="text-lg font-semibold mb-4">Round Type Weights (K Factor Multipliers)</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {Object.keys(config.WEIGHTS).map(type => (
                      <div key={type}>
                        <label className="block text-sm font-medium mb-2">{type}</label>
                        <input
                          type="number"
                          step="0.05"
                          value={config.WEIGHTS[type]}
                          onChange={(e) => setConfig({
                            ...config,
                            WEIGHTS: {...config.WEIGHTS, [type]: Number(e.target.value)}
                          })}
                          className="w-full border rounded-lg px-4 py-2"
                        />
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-gray-600 mt-4">
                    These multiply the base K factor for different round types. Lower = less rating change.
                  </p>
                </div>

                {/* Delta Caps */}
                <div className="bg-gray-50 rounded-lg p-6 mb-6">
                  <h3 className="text-lg font-semibold mb-4">Delta Caps (Maximum Rating Change)</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {Object.keys(config.DELTA_CAPS).map(type => (
                      <div key={type}>
                        <label className="block text-sm font-medium mb-2">{type}</label>
                        <div className="flex gap-2">
                          <input
                            type="number"
                            value={config.DELTA_CAPS[type] === null ? '' : config.DELTA_CAPS[type]}
                            onChange={(e) => setConfig({
                              ...config,
                              DELTA_CAPS: {...config.DELTA_CAPS, [type]: e.target.value === '' ? null : Number(e.target.value)}
                            })}
                            placeholder="No cap"
                            className="flex-1 border rounded-lg px-4 py-2"
                          />
                          <button
                            onClick={() => setConfig({
                              ...config,
                              DELTA_CAPS: {...config.DELTA_CAPS, [type]: null}
                            })}
                            className="px-3 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg text-sm"
                            title="Remove cap"
                          >
                            ∞
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-gray-600 mt-4">
                    Maximum rating points that can be gained/lost in a single round. Leave empty or click ∞ for no cap.
                  </p>
                </div>

                {/* Apply Button */}
                <div className="flex justify-end gap-4">
                  <button
                    onClick={recomputeWithNewConfig}
                    disabled={!data || processing}
                    className={`px-6 py-3 rounded-lg font-semibold transition-colors ${
                      !data || processing
                        ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700'
                    }`}
                  >
                    {processing ? 'Recomputing...' : 'Apply & Recompute'}
                  </button>
                </div>
                {!data && (
                  <p className="text-center text-gray-500 mt-4">
                    Upload data first to apply configuration changes
                  </p>
                )}
              </div>
            )}

            {/* Upload Tab */}
            {activeTab === 'upload' && (
              <div className="text-center py-12">
                <Upload className="w-16 h-16 mx-auto text-indigo-600 mb-4" />
                <h2 className="text-2xl font-bold mb-4">Upload Your Excel File</h2>
                <p className="text-gray-600 mb-6">
                  Upload an Excel file with player names in the first column and round scores in subsequent columns
                </p>
                <label className="inline-block">
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={handleFileUpload}
                    className="hidden"
                    disabled={processing}
                  />
                  <span className={`px-6 py-3 rounded-lg inline-block transition-colors ${
                    processing 
                      ? 'bg-gray-400 text-white cursor-not-allowed' 
                      : 'bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer'
                  }`}>
                    {processing ? 'Processing...' : 'Choose File'}
                  </span>
                </label>
                {error && (
                  <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                    <p className="text-red-600">{error}</p>
                  </div>
                )}
                {data && !error && (
                  <p className="mt-4 text-green-600 font-semibold">
                    ✓ File loaded: {data.length} records processed
                  </p>
                )}
              </div>
            )}

            {/* Rankings Tab */}
            {activeTab === 'rankings' && results && (
              <div>
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h2 className="text-2xl font-bold">Player Rankings</h2>
                    <p className="text-gray-600">
                      {selectedRound ? `After: ${selectedRound}` : 'Final Rankings'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <select
                      value={selectedRound || ''}
                      onChange={(e) => setSelectedRound(e.target.value || null)}
                      className="border rounded-lg px-4 py-2"
                    >
                      <option value="">Final Rankings</option>
                      {uniqueRounds.map(round => (
                        <option key={round} value={round}>{round}</option>
                      ))}
                    </select>
                    <button
                      onClick={downloadExcel}
                      className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
                    >
                      <Download className="w-5 h-5" />
                      Export
                    </button>
                  </div>
                </div>
                <div className="overflow-auto max-h-96">
                  <table className="w-full">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold">Rank</th>
                        <th className="px-4 py-3 text-left font-semibold">Player</th>
                        <th className="px-4 py-3 text-right font-semibold">Rating</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentSnapshot.map((row, idx) => (
                        <tr key={idx} className="border-b hover:bg-gray-50">
                          <td className="px-4 py-3">{idx + 1}</td>
                          <td className="px-4 py-3 font-medium">{row.player}</td>
                          <td className="px-4 py-3 text-right">{Math.round(row.rating)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* History Tab */}
            {activeTab === 'history' && results && (
              <div>
                <h2 className="text-2xl font-bold mb-4">Rating History</h2>
                <div className="overflow-auto max-h-96">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold">Round</th>
                        <th className="px-3 py-2 text-left font-semibold">Player</th>
                        <th className="px-3 py-2 text-right font-semibold">Score</th>
                        <th className="px-3 py-2 text-right font-semibold">Pre</th>
                        <th className="px-3 py-2 text-right font-semibold">Post</th>
                        <th className="px-3 py-2 text-right font-semibold">Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.history.slice(0, 200).map((row, idx) => (
                        <tr key={idx} className="border-b hover:bg-gray-50">
                          <td className="px-3 py-2 text-xs">{row.round_id}</td>
                          <td className="px-3 py-2">{row.player}</td>
                          <td className="px-3 py-2 text-right">{row.score}</td>
                          <td className="px-3 py-2 text-right">{Math.round(row.rating_pre)}</td>
                          <td className="px-3 py-2 text-right">{Math.round(row.rating_post)}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${
                            row.delta > 0 ? 'text-green-600' : row.delta < 0 ? 'text-red-600' : ''
                          }`}>
                            {row.delta > 0 ? '+' : ''}{Math.round(row.delta)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {results.history.length > 200 && (
                    <p className="text-center text-gray-500 mt-4">
                      Showing first 200 of {results.history.length} records. Download Excel for full history.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
