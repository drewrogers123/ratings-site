/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0f9ff',
          100: '#6F4E37',
          200: '#A67C52',
          300: '#A9A9A9',
          400: '#36454F',
          500: '#8F9779',
          600: '#B38B6D',
          700: '#D4B482',
          800: '#D4C9BC',
          900: '#B8A99A',
        },
      },
    },
  },
  plugins: [],
}
