interface StatCardProps {
  label: string;
  value: string;
  accent: string;
}

export function StatCard({ label, value, accent }: StatCardProps) {
  return (
    <div className="rounded-[2rem] border border-white/60 bg-white/75 p-6 shadow-panel backdrop-blur">
      <div
        className="mb-4 h-1.5 w-16 rounded-full"
        style={{ backgroundColor: accent }}
      />
      <p className="text-xs uppercase tracking-[0.28em] text-ink/60">{label}</p>
      <p className="mt-3 font-display text-4xl text-ink">{value}</p>
    </div>
  );
}
