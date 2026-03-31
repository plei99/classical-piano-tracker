/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1a1714",
        parchment: "#f4efe7",
        brass: "#a86d1d",
        pine: "#1d4f4b",
        claret: "#6d2e3b",
      },
      boxShadow: {
        panel: "0 30px 70px rgba(30, 24, 19, 0.16)",
      },
      fontFamily: {
        display: ["Iowan Old Style", "Palatino Linotype", "Book Antiqua", "Palatino", "serif"],
        sans: ["Avenir Next", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};

