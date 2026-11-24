import { useState } from 'react';
import { User } from 'lucide-react';

interface AgentAvatarProps {
  name: string;
  size?: 'sm' | 'md' | 'lg';
}

const PORTRAIT_URL = '/src/assets/images/agent_ananya_portrait_1795427163471.jpg';

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'w-9 h-9',
  md: 'w-12 h-12',
  lg: 'w-16 h-16',
};

export function AgentAvatar({ name, size = 'md' }: AgentAvatarProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`${SIZE_CLASSES[size]} rounded-full bg-teal-50 border border-teal-200 flex items-center justify-center text-teal-800 shrink-0`}
        aria-label={`${name} avatar`}
      >
        <User className="w-5 h-5" />
      </div>
    );
  }

  return (
    <img
      src={PORTRAIT_URL}
      alt={`${name} — WebDevs Hyderabad Voice Specialist`}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${SIZE_CLASSES[size]} rounded-full object-cover object-top border border-slate-200 shrink-0 bg-slate-100`}
    />
  );
}
