import { SuggestionCard } from './SuggestionCard';
import { IconBrain, IconClock, IconWorkflow, IconSparkle } from '../../components/icons';
import { useGroupConfig } from '../../hooks/useGroupConfig';

interface GreetingProps {
  moodActivity?: string;
  onSend: (text: string) => void;
  isMobile?: boolean;
}

const SUGGESTIONS = [
  {
    icon: <IconBrain size={14} />,
    title: 'MEMORY',
    desc: 'What do you remember about my reading habits?',
  },
  {
    icon: <IconClock size={14} />,
    title: 'SCHEDULE',
    desc: "What's on my plate today?",
  },
  {
    icon: <IconWorkflow size={14} />,
    title: 'WORKFLOW',
    desc: 'Draft a follow-up to the Tuesday thread.',
  },
  {
    icon: <IconSparkle size={14} />,
    title: 'IDEATE',
    desc: 'Help me think through next quarter.',
  },
];

/**
 * Empty state / greeting screen.
 * Gradient text headline, mood-aware subhead, 2×2 suggestion grid.
 * Matches design: no circle/icon above the headline (removed in design iteration).
 */
export function Greeting({ moodActivity, onSend, isMobile = false }: GreetingProps) {
  const { groupConfig } = useGroupConfig();
  const userName = groupConfig?.user?.name ?? '';
  const assistantName = groupConfig?.assistant?.name ?? '';
  const subhead = moodActivity || `${assistantName} is focused this morning. Energy is steady at 7.`;

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center relative z-10"
      style={{
        padding: isMobile ? '24px 20px' : '32px 24px',
        gap: isMobile ? 28 : 36,
      }}
    >
      {/* Headline + subhead */}
      <div className="flex flex-col items-center gap-2.5 text-center">
        <h1
          className="nc-gradient-text font-medium leading-[1.2] tracking-[-0.02em] m-0"
          style={{ fontSize: isMobile ? 26 : 32 }}
        >
          Good morning{userName ? `, ${userName}` : ''}
        </h1>
        <p
          className="text-nc-text-muted text-center leading-[1.5] m-0"
          style={{ fontSize: 13.5, maxWidth: 360 }}
        >
          {subhead}
        </p>
      </div>

      {/* Suggestion grid */}
      <div
        className="grid grid-cols-2 w-full"
        style={{
          gap: 10,
          maxWidth: isMobile ? 320 : 560,
        }}
      >
        {SUGGESTIONS.map((s, i) => (
          <SuggestionCard
            key={i}
            {...s}
            compact={isMobile}
            onClick={() => onSend(s.desc)}
            className={`nc-msg nc-stagger-${i}`}
          />
        ))}
      </div>
    </div>
  );
}
