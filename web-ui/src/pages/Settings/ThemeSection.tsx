import { SettingsCard } from './SettingsCard';
import { ThemeToggle } from '../../components/shell/ThemeToggle';

interface ThemeSectionProps {
  span?: number;
}

export function ThemeSection({ span = 6 }: ThemeSectionProps) {
  return (
    <SettingsCard title="Theme" span={span}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-nc-text">Dark mode</span>
        <ThemeToggle />
      </div>
    </SettingsCard>
  );
}
