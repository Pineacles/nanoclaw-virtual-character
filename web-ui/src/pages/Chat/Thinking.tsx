/**
 * Thinking indicator — three bouncing dots + "Thinking…" label.
 * Shown when isTyping is true and no streaming content yet.
 */
export function Thinking() {
  return (
    <div className="flex items-center gap-2 py-1 pl-[17px]">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-nc-accent opacity-85"
            style={{
              animation: `nc-bounce 1.2s ${i * 0.16}s ease-in-out infinite`,
            }}
          />
        ))}
      </div>
      <span className="text-[12.5px] text-nc-text-muted italic">Thinking…</span>
    </div>
  );
}
