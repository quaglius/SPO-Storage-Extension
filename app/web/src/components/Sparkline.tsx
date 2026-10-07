import { ResponsiveContainer, Line, LineChart } from 'recharts';

interface SparklineProps {
  data: number[];
  color?: string;
}

export function Sparkline({ data, color = 'var(--accent)' }: SparklineProps) {
  const points = data.map((value, index) => ({ index, value }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
