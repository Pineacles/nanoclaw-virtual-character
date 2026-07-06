import { useCallback, useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { api } from '../../lib/api';
import { BackgroundMesh } from '../../components/ui/BackgroundMesh';
import { IdentitySection } from './IdentitySection';
import { ModelSection } from './ModelSection';
import { WebSearchSection } from './WebSearchSection';
import { SubsystemsSection } from './SubsystemsSection';
import { ThemeSection } from './ThemeSection';

interface SettingsPageProps {
  isMobile: boolean;
  authenticated: boolean;
}

interface Settings {
  model?: string;
  perplexity_enabled?: boolean;
}

interface GroupConfig {
  features?: Record<string, boolean>;
  assistant?: { name?: string };
  user?: { name?: string };
  [key: string]: unknown;
}

interface FeatureHealth {
  enabled: boolean;
  healthy: boolean;
  missing_tasks?: string[];
}

/**
 * Settings page.
 * Desktop: 12-column bento grid.
 * Mobile: stacked cards, FULL content parity (same sections, one column).
 * Source: NCSettingsDesktop/NCSettingsMobile in nanoclaw-pages.jsx lines 692-916.
 */
export function SettingsPage({ isMobile, authenticated }: SettingsPageProps) {
  const [settings, setSettings] = useState<Settings>({});
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [featureHealth, setFeatureHealth] = useState<Record<string, FeatureHealth>>({});
  const [assistantName, setAssistantName] = useState('');
  const [userName, setUserName] = useState('');
  const [isSavingNames, setIsSavingNames] = useState(false);
  const [groupConfig, setGroupConfig] = useState<GroupConfig>({});

  useEffect(() => {
    if (!authenticated) return;
    api.get<Settings>('/api/settings').then(setSettings).catch(() => {});
    api.get<GroupConfig>('/api/group-config').then((c) => {
      setGroupConfig(c);
      setFeatures(c.features || {});
      setAssistantName(c.assistant?.name || '');
      setUserName(c.user?.name || '');
    }).catch(() => {});
    api.get<Record<string, FeatureHealth>>('/api/feature-health').then(setFeatureHealth).catch(() => {});
  }, [authenticated]);

  const toggleFeature = useCallback(async (key: string) => {
    const updated = { ...features, [key]: !features[key] };
    setFeatures(updated);
    const freshConfig = await api.get<GroupConfig>('/api/group-config');
    await api.put('/api/group-config', { ...freshConfig, features: updated });
    api.get<Record<string, FeatureHealth>>('/api/feature-health').then(setFeatureHealth).catch(() => {});
  }, [features]);

  const handleSaveSettings = useCallback(async (patch: Partial<Settings>) => {
    const updated = { ...settings, ...patch };
    setSettings(updated);
    await api.put('/api/settings', updated).catch(() => {});
  }, [settings]);

  const handleSaveNames = useCallback(async () => {
    setIsSavingNames(true);
    try {
      const fresh = await api.get<GroupConfig>('/api/group-config');
      await api.put('/api/group-config', {
        ...fresh,
        assistant: { ...(fresh.assistant as Record<string, unknown> || {}), name: assistantName, trigger: `@${assistantName}` },
        user: { ...(fresh.user as Record<string, unknown> || {}), name: userName },
      });
      setGroupConfig({ ...fresh });
    } finally {
      setIsSavingNames(false);
    }
  }, [assistantName, userName]);

  void groupConfig; // consumed indirectly via fresh fetch

  const perplexityEnabled = settings.perplexity_enabled ?? false;
  const model = settings.model ?? 'claude-sonnet-4-5';

  const sections = (
    <>
      <IdentitySection
        assistantName={assistantName}
        userName={userName}
        onAssistantChange={setAssistantName}
        onUserChange={setUserName}
        onSave={() => void handleSaveNames()}
        isSaving={isSavingNames}
        isMobile={isMobile}
      />
      <ModelSection
        model={model}
        onChange={(m) => void handleSaveSettings({ model: m })}
        span={isMobile ? 12 : 7}
      />
      <WebSearchSection
        enabled={perplexityEnabled}
        onToggle={() => void handleSaveSettings({ perplexity_enabled: !perplexityEnabled })}
        span={isMobile ? 12 : 5}
      />
      <SubsystemsSection
        features={features}
        featureHealth={featureHealth}
        onToggle={(k) => void toggleFeature(k)}
        isMobile={isMobile}
      />
      <ThemeSection span={isMobile ? 12 : 6} />
    </>
  );

  return (
    <BackgroundMesh variant="filled" className="flex flex-col h-full">
      {/* Page header */}
      <div
        className={cn(
          'nc-page flex-shrink-0 bg-nc-bg border-b border-nc-border-soft',
          'flex items-center',
          isMobile ? 'px-4 py-3 h-14' : 'px-6 py-4',
        )}
      >
        <div>
          <h1 className={cn('text-nc-text font-semibold tracking-[-0.01em] m-0', isMobile ? 'text-[15px]' : 'text-[17px]')}>
            Settings
          </h1>
          <p className="text-[12px] text-nc-text-dim m-0 mt-0.5">System configuration</p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {isMobile ? (
          /* Mobile: stacked cards, one column, full content parity */
          <div className="flex flex-col gap-3 p-3">
            {sections}
          </div>
        ) : (
          /* Desktop: 12-col bento grid */
          <div className="p-5 px-6">
            <div className="grid grid-cols-12 gap-3 max-w-[980px] mx-auto">
              {sections}
            </div>
          </div>
        )}
      </div>
    </BackgroundMesh>
  );
}
