import "./Spinner.css";

export default function Spinner() {
  return (
    <div class="spinner">
      <svg viewBox="0 0 36 36">
        <defs>
          <linearGradient id="gradient">
            <stop offset="0" stop-color="var(--color)"></stop>
            <stop
              offset="100%"
              stop-color="var(--color)"
              stop-opacity="0"
            ></stop>
          </linearGradient>
        </defs>
        <circle cx="50%" cy="50%" r="18"></circle>
      </svg>
    </div>
  );
}
