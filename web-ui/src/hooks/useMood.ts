// Copied from web-ui-legacy — unchanged.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export interface MoodScheduleSlot {
  time: string;
  mood: string;
  energy: number;
  activity?: string;
  distribution?: Record<string, number>;
}

export interface MoodData {
  current_mood: string;
  energy: number;
  activity: string;
  updated_at: string;
  schedule?: MoodScheduleSlot[];
}

export function useMood(authenticated: boolean) {
  const [mood, setMood] = useState<MoodData>({
    current_mood: 'focused',
    energy: 7,
    activity: '',
    updated_at: '',
  });
  const setMoodRef = useRef(setMood);
  setMoodRef.current = setMood;

  const fetchMood = useCallback(async () => {
    if (!authenticated) return;
    try {
      const data = await api.get<MoodData>('/api/mood');
      setMoodRef.current(data);
    } catch {
      // ignore
    }
  }, [authenticated]);

  useEffect(() => {
    fetchMood();
  }, [fetchMood]);

  return { mood, setMood };
}

/**
 * Canonical mood color map — covers every mood listed in the persona's CLAUDE.md.
 * Sourced from web-ui-legacy/MoodBlob so colors stay stable across UIs.
 */
export const MOOD_COLORS: Record<string, string> = {
  sleeping: '#444441',
  tired: '#D3D1C7',
  chill: '#9FE1CB',
  focused: '#FAC775',
  playful: '#F4C0D1',
  soft: '#FBEAF0',
  annoyed: '#F09595',
  excited: '#FAC775',
  training: '#C0DD97',
  eating: '#F5C4B3',
  crying: '#B5D4F4',
  restless: '#E8C171',
  embarrassed: '#F28FB5',
  nostalgic: '#E2B5C2',
  content: '#F5E6C8',
  proud: '#F2C94C',
  anxious: '#D9DC8E',
  bored: '#C6C2B5',
  lonely: '#A5BCD6',
  relieved: '#C5E8D9',
  grateful: '#E8C77D',
  guilty: '#B8A5BD',
  confused: '#C9B8E0',
  melancholy: '#9CA6C7',
  giddy: '#F4A5C5',
  tender: '#F5D1DB',
  irritated: '#E89671',
  overwhelmed: '#9D93A8',
  determined: '#D49736',
  amused: '#F4D976',
  wistful: '#BDC6D4',
  happy: '#F9D24A',
  in_love: '#E47B9D',
};

export function getMoodColor(moodName: string): string {
  return MOOD_COLORS[moodName] ?? MOOD_COLORS.chill;
}
