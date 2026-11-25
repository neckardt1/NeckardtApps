import { useEffect, useState } from 'react';
import { grades, type Grade } from './review-session.ts';
import type { RecallApi, ReviewIntervals } from './recall-api.ts';

const labels: Record<Grade, string> = { miss: 'Again', hard: 'Hard', medium: 'Good', easy: 'Easy' };

function intervalLabel(minutes: number) {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${Math.round(minutes / 6) / 10} hr`;
  const days = Math.round(minutes / 1440);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export function RatingButtons({ cardId, revision, preview, disabled, rate }: {
  cardId: string; revision: number; preview: RecallApi['preview']; disabled: boolean; rate: (grade: Grade) => void;
}) {
  const [intervals, setIntervals] = useState<ReviewIntervals | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let current = true;
    preview?.(cardId, revision).then(
      values => { if (current) setIntervals(values); },
      () => { if (current) setUnavailable(true); }
    );
    return () => { current = false; };
  }, [cardId, revision, preview]);

  return <>
    {unavailable && <p className="status" role="status">Review intervals unavailable.</p>}
    <div className="ratings" aria-label="Rate your recall">
      {grades.map((grade, i) => {
        const interval = intervals && intervalLabel(intervals[grade]);
        return <button className="secondary" key={grade} disabled={disabled} onClick={() => rate(grade)}
          aria-keyshortcuts={String(i + 1)} aria-label={labels[grade]}
          aria-description={interval ? `Next review in ${interval}` : undefined}>
          {labels[grade]}{preview && !unavailable && <small aria-hidden="true">{interval ?? '…'}</small>}
        </button>;
      })}
    </div>
  </>;
}
