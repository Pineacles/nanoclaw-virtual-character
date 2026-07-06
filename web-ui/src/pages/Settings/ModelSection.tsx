import { cn } from '../../lib/cn';
import { SettingsCard } from './SettingsCard';

const MODELS = [
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', desc: 'Balanced · default' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5', desc: 'Deepest reasoning · slower' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Fastest · for short asks' },
] as const;

type ModelId = typeof MODELS[number]['id'];

interface ModelSectionProps {
  model: string;
  onChange: (id: string) => void;
  span?: number;
}

export function ModelSection({ model, onChange, span = 7 }: ModelSectionProps) {
  return (
    <SettingsCard title="Model" span={span}>
      <div className="flex flex-col gap-1.5">
        {MODELS.map((m) => {
          const isActive = model === m.id;
          return (
            <label
              key={m.id}
              className={cn(
                'nc-press flex items-center gap-2.5 px-3 py-2.5 rounded-[9px] border cursor-pointer',
                'transition-colors duration-[--nc-dur-micro]',
                isActive
                  ? 'bg-nc-accent-soft border-[color:var(--nc-accent)]/40'
                  : 'bg-transparent border-nc-border hover:bg-nc-surface-hi',
              )}
            >
              <input
                type="radio"
                name="model-select"
                value={m.id}
                checked={isActive}
                onChange={() => onChange(m.id)}
                className="sr-only"
                aria-label={m.label}
              />
              {/* Radio circle */}
              <span
                aria-hidden="true"
                className={cn(
                  'w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center',
                  isActive ? 'border-nc-accent bg-nc-accent' : 'border-nc-border bg-transparent',
                )}
              >
                {isActive && (
                  <span className="w-[6px] h-[6px] rounded-full bg-white block" />
                )}
              </span>
              <div className="flex-1">
                <div className="text-[13px] text-nc-text font-medium">{m.label}</div>
                <div className="text-[11.5px] text-nc-text-muted">{m.desc}</div>
              </div>
            </label>
          );
        })}
      </div>
    </SettingsCard>
  );
}

export type { ModelId };
