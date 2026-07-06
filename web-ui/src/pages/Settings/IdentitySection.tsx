import { cn } from '../../lib/cn';
import { SettingsCard } from './SettingsCard';

interface IdentitySectionProps {
  assistantName: string;
  userName: string;
  onAssistantChange: (v: string) => void;
  onUserChange: (v: string) => void;
  onSave: () => void;
  isSaving: boolean;
  isMobile: boolean;
}

export function IdentitySection({
  assistantName, userName, onAssistantChange, onUserChange, onSave, isSaving, isMobile,
}: IdentitySectionProps) {
  const inputClass = cn(
    'h-[36px] rounded-btn border border-nc-border bg-nc-surface-alt',
    'px-3 text-[14px] text-nc-text font-medium outline-none',
    'focus:border-nc-accent transition-colors duration-[--nc-dur-micro] w-full',
  );

  const labelClass = 'text-[11px] text-nc-text-dim font-medium uppercase tracking-[0.04em] mb-1.5 block';

  return (
    <SettingsCard title="Identity" span={12} action={
      <button
        type="button"
        onClick={onSave}
        disabled={isSaving}
        aria-label="Save names"
        className="nc-press nc-gradient-fill h-7 px-3 rounded-btn text-[12px] text-white font-medium disabled:opacity-50 cursor-pointer"
      >
        {isSaving ? 'Saving…' : 'Save'}
      </button>
    }>
      <div className={cn(
        'grid gap-3',
        isMobile ? 'grid-cols-1' : 'grid-cols-2',
      )}>
        <div>
          <label htmlFor="settings-assistant-name" className={labelClass}>Assistant name</label>
          <input
            id="settings-assistant-name"
            type="text"
            value={assistantName}
            onChange={(e) => onAssistantChange(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="settings-user-name" className={labelClass}>Your name</label>
          <input
            id="settings-user-name"
            type="text"
            value={userName}
            onChange={(e) => onUserChange(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>
    </SettingsCard>
  );
}
