import React, { useState, useMemo } from 'react';
import { Upload, Download, Settings, TrendingUp, Users, X , Variable} from 'lucide-react';
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
  const [showConfigModal, setShowConfigModal] = useState(false);
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
    <div className="min-h-screen bg-stone-50 w-full">
      <div className="w-full">
    {/* Header */}
    <div className="bg-gradient-to-br from-emerald-900 to-stone-600 text-stone-200 w-full">
      <div className="w-full px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-4 mb-4">
              <Variable className="w-12 h-12" />
              <h1 className="text-5xl font-light tracking-wide">Disc Golf Elo Calculator</h1>
            </div>
            <p className="text-xl text-stone-300 max-w-2xl font-light">
              Multiplayer rating engine with granular configuration options.
            </p>
          </div>
          <button
            onClick={() => setShowConfigModal(true)}
            className="flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 rounded-lg transition-all duration-200 backdrop-blur-sm border border-white/20"
          >
            <Settings className="w-5 h-5" />
            <span className="font-normal">Configure</span>
          </button>
        </div>
      </div>
    </div>

    {/* Tabs */}
    <div className="w-full px-6 py-12">
      <div className="flex gap-2 mb-12 border-b border-stone-200">
        <button
          onClick={() => setActiveTab('upload')}
          className={`flex items-center gap-2 px-6 py-4 font-normal transition-all duration-200 border-b-2 ${
            activeTab === 'upload'
              ? 'border-emerald-800 text-emerald-900'
              : 'border-transparent text-stone-500 hover:text-stone-700'
          }`}
        >
          <Upload className="w-5 h-5" />
          Upload data
        </button>
        <button
          onClick={() => setActiveTab('rankings')}
          disabled={!results}
          className={`flex items-center gap-2 px-6 py-4 font-normal transition-all duration-200 border-b-2 ${
            activeTab === 'rankings'
              ? 'border-emerald-800 text-emerald-900'
              : 'border-transparent text-stone-500 hover:text-stone-700 disabled:text-stone-300 disabled:cursor-not-allowed'
          }`}
        >
          <TrendingUp className="w-5 h-5" />
          Rankings
        </button>
        <button
          onClick={() => setActiveTab('history')}
          disabled={!results}
          className={`flex items-center gap-2 px-6 py-4 font-normal transition-all duration-200 border-b-2 ${
            activeTab === 'history'
              ? 'border-emerald-800 text-emerald-900'
              : 'border-transparent text-stone-500 hover:text-stone-700 disabled:text-stone-300 disabled:cursor-not-allowed'
          }`}
        >
          <Users className="w-5 h-5" />
          History
        </button>
      </div>

      {/* Upload Tab */}
      {activeTab === 'upload' && (
        <div className="max-w-2xl mx-auto">
          <div className="bg-stone-100 rounded-2xl p-16 text-center border border-stone-200">
            <Upload className="w-20 h-20 mx-auto text-stone-400 mb-6" />
            <h2 className="text-3xl font-light text-stone-900 mb-4">Upload your data</h2>
            <p className="text-lg text-stone-600 mb-8 max-w-md mx-auto font-light">
              Upload an Excel file with player names and round scores to calculate ratings
            </p>
            <div className="flex flex-col gap-4 items-center mb-6">
              <label className="inline-block">
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleFileUpload}
                  className="hidden"
                  disabled={processing}
                />
                <span className={`px-10 py-3 rounded-xl font-normal text-lg inline-block transition-all duration-200 ${
                  processing 
                    ? 'bg-stone-300 text-stone-500 cursor-not-allowed' 
                    : 'bg-emerald-900 text-stone-100 hover:bg-emerald-800 cursor-pointer shadow-lg hover:shadow-xl'
                }`}>
                  {processing ? 'Processing...' : 'Choose file'}
                </span>
              </label>
              <div className="flex items-center gap-4">
                <div className="h-px w-8 bg-stone-300"></div>
                <span className="text-stone-500 text-sm">or</span>
                <div className="h-px w-8 bg-stone-300"></div>
              </div>
              <a 
                href={`${process.env.PUBLIC_URL}/samplescores.xlsx`} 
                download
                className="px-6 py-3 rounded-xl font-normal text-base bg-white text-emerald-900 border-2 border-emerald-900 hover:bg-emerald-50 transition-all duration-200 flex items-center"
              >
                <Download className="w-4 h-4 mr-2" />
                Download Sample Data
              </a>
            </div>
            {error && (
              <div className="mt-8 p-6 bg-red-50 border border-red-200 rounded-xl">
                <p className="text-red-700 font-normal">{error}</p>
              </div>
            )}
            {data && !error && (
              <div className="mt-8 p-6 bg-emerald-50 border border-emerald-600 rounded-xl">
                <p className="text-emerald-600 font-normal text-lg">
                  ✓ Successfully loaded {data.length} records
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Rankings Tab */}
      {activeTab === 'rankings' && results && (
        <div>
          <div className="flex justify-between items-center mb-8">
            <div>
              <h2 className="text-3xl font-light text-stone-900 mb-2">Player rankings</h2>
              <p className="text-lg text-stone-600 font-light">
                {selectedRound ? `After: ${selectedRound}` : 'Final rankings'}
              </p>
            </div>
            <div className="flex gap-3">
              <select
                value={selectedRound || ''}
                onChange={(e) => setSelectedRound(e.target.value || null)}
                className="border border-stone-300 rounded-xl px-4 py-3 text-stone-700 font-normal focus:outline-none focus:ring-2 focus:ring-emerald-800 bg-white"
              >
                <option value="">Final rankings</option>
                {uniqueRounds.map(round => (
                  <option key={round} value={round}>{round}</option>
                ))}
              </select>
              <button
                onClick={downloadExcel}
                className="flex items-center gap-2 bg-emerald-900 text-stone-50 px-6 py-3 rounded-xl font-normal hover:bg-emerald-800 transition-all duration-200 shadow-lg hover:shadow-xl"
              >
                <Download className="w-5 h-5" />
                Export
              </button>
            </div>
          </div>
          <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden shadow-sm">
            <div className="overflow-auto" style={{maxHeight: '600px'}}>
              <table className="w-full">
                <thead className="bg-stone-100 sticky top-0 border-b border-stone-200">
                  <tr>
                    <th className="px-6 py-4 text-left text-sm font-normal text-stone-600">Rank</th>
                    <th className="px-6 py-4 text-left text-sm font-normal text-stone-600">Player</th>
                    <th className="px-6 py-4 text-right text-sm font-normal text-stone-600">Rating</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {currentSnapshot.map((row, idx) => (
                    <tr key={idx} className="hover:bg-stone-50 transition-colors">
                      <td className="px-6 py-4 text-stone-500 font-normal">{idx + 1}</td>
                      <td className="px-6 py-4 text-stone-900 font-normal text-lg">{row.player}</td>
                      <td className="px-6 py-4 text-right text-stone-900 font-medium text-xl">{Math.round(row.rating)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* History Tab */}
      {activeTab === 'history' && results && (
        <div>
          <div className="mb-8">
            <h2 className="text-3xl font-light text-stone-900 mb-2">Rating history</h2>
            <p className="text-lg text-stone-600 font-light">Complete record of rating changes</p>
          </div>
          <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden shadow-sm">
            <div className="overflow-auto" style={{maxHeight: '600px'}}>
              <table className="w-full">
                <thead className="bg-stone-100 sticky top-0 border-b border-stone-200">
                  <tr>
                    <th className="px-4 py-4 text-left text-xs font-normal text-stone-600">Round</th>
                    <th className="px-4 py-4 text-left text-xs font-normal text-stone-600">Player</th>
                    <th className="px-4 py-4 text-right text-xs font-normal text-stone-600">Score</th>
                    <th className="px-4 py-4 text-right text-xs font-normal text-stone-600">Pre</th>
                    <th className="px-4 py-4 text-right text-xs font-normal text-stone-600">Post</th>
                    <th className="px-4 py-4 text-right text-xs font-normal text-stone-600">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {results.history.slice(0, 200).map((row, idx) => (
                    <tr key={idx} className="hover:bg-stone-50 transition-colors">
                      <td className="px-4 py-3 text-xs text-stone-600">{row.round_id}</td>
                      <td className="px-4 py-3 text-stone-900 font-normal">{row.player}</td>
                      <td className="px-4 py-3 text-right text-stone-700">{row.score}</td>
                      <td className="px-4 py-3 text-right text-stone-700">{Math.round(row.rating_pre)}</td>
                      <td className="px-4 py-3 text-right text-stone-900 font-medium">{Math.round(row.rating_post)}</td>
                      <td className={`px-4 py-3 text-right font-medium ${
                        row.delta > 0 ? 'text-emerald-700' : row.delta < 0 ? 'text-amber-700' : 'text-stone-400'
                      }`}>
                        {row.delta > 0 ? '+' : ''}{Math.round(row.delta)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {results.history.length > 200 && (
              <div className="px-6 py-4 bg-stone-100 border-t border-stone-200 text-center text-stone-600 font-light">
                Showing first 200 of {results.history.length} records. Download Excel for complete history.
              </div>
            )}
          </div>
        </div>
      )}
    </div>

    {/* Configuration Modal */}
    {showConfigModal && (
      <div className="fixed inset-0 bg-black/50 flex items-start justify-center p-4 z-50 overflow-y-auto">
        <div className="bg-stone-50 rounded-2xl w-full max-w-4xl my-8 overflow-hidden">
          <div className="sticky top-0 bg-stone-50 border-b border-stone-200 px-4 sm:px-6 py-4 flex justify-between items-center">
            <h2 className="text-xl sm:text-2xl font-light text-stone-900">Algorithm configuration</h2>
            <button
              onClick={() => setShowConfigModal(false)}
              className="p-1 sm:p-2 hover:bg-stone-200 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 sm:w-6 sm:h-6 text-stone-600" />
            </button>
          </div>

          <div className="p-4 sm:p-6 space-y-6">
            {/* Basic Settings */}
            <div>
              <h3 className="text-lg font-normal text-stone-900 mb-4">Basic settings</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                <div>
                  <label className="block text-sm font-normal text-stone-700 mb-2">Base K factor</label>
                  <input
                    type="number"
                    value={config.BASE_K}
                    onChange={(e) => setConfig({...config, BASE_K: Number(e.target.value)})}
                    className="w-full border border-stone-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-800 bg-white"
                  />
                  <p className="text-xs text-stone-500 mt-1 font-light">Determines how much ratings change per game</p>
                </div>
                <div>
                  <label className="block text-sm font-normal text-stone-700 mb-2">Starting rating</label>
                  <input
                    type="number"
                    value={config.START_RATING}
                    onChange={(e) => setConfig({...config, START_RATING: Number(e.target.value)})}
                    className="w-full border border-stone-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-800 bg-white"
                  />
                  <p className="text-xs text-stone-500 mt-1 font-light">Initial rating for new players</p>
                </div>
                <div>
                  <label className="block text-sm font-normal text-stone-700 mb-2">Use margin of victory</label>
                  <select
                    value={config.USE_MOV ? 'true' : 'false'}
                    onChange={(e) => setConfig({...config, USE_MOV: e.target.value === 'true'})}
                    className="w-full border border-stone-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-800 bg-white"
                  >
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                  <p className="text-xs text-stone-500 mt-1 font-light">Scale rating changes by score difference</p>
                </div>
                <div>
                  <label className="block text-sm font-normal text-stone-700 mb-2">Apply delta cap from round</label>
                  <input
                    type="number"
                    value={config.DELTA_CAP_START_ROUND}
                    onChange={(e) => setConfig({...config, DELTA_CAP_START_ROUND: Number(e.target.value)})}
                    className="w-full border border-stone-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-800 bg-white"
                  />
                  <p className="text-xs text-stone-500 mt-1 font-light">Start capping rating changes after this round</p>
                </div>
              </div>
            </div>

            {/* Round Type Weights */}
            <div>
              <h3 className="text-lg font-normal text-stone-900 mb-4">Round type weights (K factor multipliers)</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                {Object.keys(config.WEIGHTS).map(type => (
                  <div key={type}>
                    <label className="block text-sm font-normal text-stone-700 mb-2">{type}</label>
                    <input
                      type="number"
                      step="0.05"
                      value={config.WEIGHTS[type]}
                      onChange={(e) => setConfig({
                        ...config,
                        WEIGHTS: {...config.WEIGHTS, [type]: Number(e.target.value)}
                      })}
                      className="w-full border border-stone-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-800 bg-white"
                    />
                  </div>
                ))}
              </div>
              <p className="text-xs text-stone-500 mt-4 font-light">
                These multiply the base K factor for different round types. Lower = less rating change.
              </p>
            </div>

            {/* Delta Caps */}
            <div>
              <h3 className="text-lg font-normal text-stone-900 mb-4">Delta caps (maximum rating change)</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                {Object.keys(config.DELTA_CAPS).map(type => (
                  <div key={type}>
                    <label className="block text-sm font-normal text-stone-700 mb-2">{type}</label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={config.DELTA_CAPS[type] === null ? '' : config.DELTA_CAPS[type]}
                        onChange={(e) => setConfig({
                          ...config,
                          DELTA_CAPS: {...config.DELTA_CAPS, [type]: e.target.value === '' ? null : Number(e.target.value)}
                        })}
                        placeholder="No cap"
                        className="flex-1 border border-stone-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-800 bg-white"
                      />
                      <button
                        onClick={() => setConfig({
                          ...config,
                          DELTA_CAPS: {...config.DELTA_CAPS, [type]: null}
                        })}
                        className="px-3 py-3 bg-stone-200 hover:bg-stone-300 rounded-lg text-sm transition-colors"
                        title="Remove cap"
                      >
                        ∞
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-stone-500 mt-4 font-light">
                Maximum rating points that can be gained/lost in a single round. Leave empty or click ∞ for no cap.
              </p>
            </div>
          </div>

          {/* Modal Footer */}
          <div className="sticky bottom-0 bg-stone-100 border-t border-stone-200 px-8 py-6 flex justify-between items-center">
            <button
              onClick={resetToDefaults}
              className="px-6 py-3 text-stone-700 font-normal hover:bg-stone-200 rounded-lg transition-colors"
            >
              Reset to defaults
            </button>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfigModal(false)}
                className="px-6 py-3 text-stone-700 font-normal hover:bg-stone-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  recomputeWithNewConfig();
                  setShowConfigModal(false);
                }}
                disabled={!data || processing}
                className={`px-8 py-3 rounded-xl font-normal transition-all duration-200 ${
                  !data || processing
                    ? 'bg-stone-300 text-stone-500 cursor-not-allowed'
                    : 'bg-emerald-900 text-stone-50 hover:bg-emerald-800 shadow-lg hover:shadow-xl'
                }`}
              >
                {processing ? 'Recomputing...' : 'Apply & recompute'}
              </button>
            </div>
          </div>
          {!data && (
            <div className="px-8 pb-6">
              <p className="text-center text-stone-500 font-light">
                Upload data first to apply configuration changes
              </p>
            </div>
          )}
        </div>
      </div>
    )}
      </div>
    </div>
  );
}