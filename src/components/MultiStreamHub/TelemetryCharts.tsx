import React, { useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type DotItemDotProps,
  type TooltipContentProps,
} from 'recharts';

export interface SparklinePoint {
  value: number;
  label?: string;
}

export interface BitrateChartPoint {
  timeLabel: string;
  value: number;
}

export interface FpsChartPoint {
  timeLabel: string;
  fps: number;
}

interface SparklineChartProps {
  data: SparklinePoint[];
  color?: string;
  height?: number;
  unit?: string;
  ariaLabel?: string;
}

interface BitrateAreaChartProps {
  data: BitrateChartPoint[];
  accentColor?: string;
  height?: number;
  startLabel?: string;
  midLabel?: string;
  endLabel?: string;
}

interface FpsLineChartProps {
  data: FpsChartPoint[];
  targetFps?: number;
  accentColor?: string;
  height?: number;
  startLabel?: string;
  midLabel?: string;
  endLabel?: string;
}

const sanitizeSvgId = (rawId: string): string => rawId.replace(/[^a-zA-Z0-9_-]/g, '');

const normalizeSeries = <T,>(items: T[], createFallback: () => T): { series: T[]; hasData: boolean } => {
  if (items.length === 0) {
    return { series: [createFallback(), createFallback()], hasData: false };
  }
  if (items.length === 1) {
    return { series: [items[0], items[0]], hasData: true };
  }
  return { series: items, hasData: true };
};

const renderEndGlowDot = (
  lastIndex: number,
  color: string,
  enabled: boolean,
  radius = 3
) => {
  return (props: DotItemDotProps): React.ReactNode => {
    if (!enabled || props.index !== lastIndex) return null;
    if (typeof props.cx !== 'number' || typeof props.cy !== 'number') return null;
    if (Number.isNaN(props.cx) || Number.isNaN(props.cy)) return null;

    return (
      <g key={`end-dot-${props.index}`}>
        <circle cx={props.cx} cy={props.cy} r={radius + 3.5} fill={color} fillOpacity={0.25} />
        <circle
          cx={props.cx}
          cy={props.cy}
          r={radius}
          fill={color}
          stroke="#0b0f14"
          strokeWidth={1.5}
        />
      </g>
    );
  };
};

const createTooltipRenderer = (
  unit: string,
  accentColor: string,
  formatValue?: (value: number) => string
) => {
  return (props: TooltipContentProps): React.ReactNode => {
    const { active, payload, label } = props;
    if (!active || !payload || payload.length === 0) return null;
    const rawValue = payload[0]?.value;
    const numericValue = typeof rawValue === 'number' ? rawValue : Number(rawValue ?? 0);
    const displayValue = formatValue
      ? formatValue(numericValue)
      : `${Math.round(numericValue * 10) / 10}`;

    return (
      <div
        style={{
          backgroundColor: 'rgba(7, 10, 14, 0.96)',
          border: '1px solid rgba(255, 255, 255, 0.14)',
          borderRadius: '8px',
          padding: '6px 9px',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.65)',
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          color: '#dee2ee',
          pointerEvents: 'none',
        }}
      >
        {label !== undefined && label !== '' && (
          <div style={{ color: '#a7b0c0', fontSize: '10px', marginBottom: '2px' }}>
            {String(label)}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}>
          <span
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              backgroundColor: accentColor,
              display: 'inline-block',
            }}
          />
          <span>
            {displayValue} {unit}
          </span>
        </div>
      </div>
    );
  };
};

const formatBitrateAxisTick = (value: number): string => {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}M`;
  }
  return `${Math.round(value)}`;
};

const axisFooterStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  color: 'var(--on-surface-muted)',
  paddingLeft: '36px',
  paddingRight: '4px',
  marginTop: '2px',
};

/**
 * Compact sparkline with SVG gradient fill and glowing terminal point.
 */
export const SparklineChart: React.FC<SparklineChartProps> = ({
  data,
  color = '#ff4d6d',
  height = 28,
  unit = '',
  ariaLabel = 'Telemetry sparkline',
}) => {
  const gradientId = `spark-grad-${sanitizeSvgId(useId())}`;
  const { series, hasData } = normalizeSeries(data, () => ({ value: 0, label: '' }));
  const lastIndex = series.length - 1;

  return (
    <div
      aria-label={ariaLabel}
      style={{ width: '100%', height: `${height}px`, minWidth: 0, position: 'relative' }}
    >
      <ResponsiveContainer
        width="100%"
        height={height}
        initialDimension={{ width: 140, height }}
      >
        <AreaChart data={series} margin={{ top: 4, right: 5, bottom: 3, left: 2 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={hasData ? 0.38 : 0.1} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={['auto', 'auto']} hide />
          {hasData && unit && (
            <Tooltip
              content={createTooltipRenderer(unit, color)}
              cursor={{ stroke: 'rgba(255,255,255,0.16)', strokeWidth: 1 }}
            />
          )}
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeOpacity={hasData ? 1 : 0.35}
            strokeWidth={1.75}
            fill={`url(#${gradientId})`}
            dot={renderEndGlowDot(lastIndex, color, hasData, 2.5)}
            activeDot={hasData ? { r: 3.5, fill: color, stroke: '#0b0f14', strokeWidth: 1.5 } : false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

/**
 * Smooth gradient area chart for real-time stream bitrate and throughput.
 */
export const BitrateAreaChart: React.FC<BitrateAreaChartProps> = ({
  data,
  accentColor = '#ff4d6d',
  height = 112,
  startLabel = '-60s',
  midLabel = '-30s',
  endLabel = 'Now',
}) => {
  const gradientId = `bitrate-grad-${sanitizeSvgId(useId())}`;
  const { series, hasData } = normalizeSeries(data, () => ({ timeLabel: '', value: 0 }));
  const lastIndex = series.length - 1;

  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <div style={{ width: '100%', height: `${height}px` }}>
        <ResponsiveContainer
          width="100%"
          height={height}
          initialDimension={{ width: 280, height }}
        >
          <AreaChart data={series} margin={{ top: 6, right: 6, bottom: 2, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accentColor} stopOpacity={0.36} />
                <stop offset="95%" stopColor={accentColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.06)" vertical={false} />
            <XAxis dataKey="timeLabel" hide />
            <YAxis
              width={36}
              axisLine={false}
              tickLine={false}
              tickFormatter={formatBitrateAxisTick}
              tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'var(--font-mono)' }}
              domain={[0, (max: number) => Math.max(500, Math.ceil((max || 0) * 1.15))]}
            />
            <Tooltip
              content={createTooltipRenderer('kbps', accentColor, (v) => Math.round(v).toLocaleString())}
              cursor={{ stroke: 'rgba(255, 255, 255, 0.16)', strokeWidth: 1 }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={accentColor}
              strokeOpacity={hasData ? 1 : 0.4}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={renderEndGlowDot(lastIndex, accentColor, hasData, 3)}
              activeDot={{ r: 4, fill: accentColor, stroke: '#0b0f14', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div style={axisFooterStyle}>
        <span>{startLabel}</span>
        <span>{midLabel}</span>
        <span>{endLabel}</span>
      </div>
    </div>
  );
};

/**
 * Stability line chart for FPS tracking against the selected frame-rate target.
 */
export const FpsLineChart: React.FC<FpsLineChartProps> = ({
  data,
  targetFps = 60,
  accentColor = '#7bd0ff',
  height = 104,
  startLabel = '-60s',
  midLabel = '-30s',
  endLabel = 'Now',
}) => {
  const { series, hasData } = normalizeSeries(data, () => ({ timeLabel: '', fps: 0 }));
  const lastIndex = series.length - 1;

  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <div style={{ width: '100%', height: `${height}px` }}>
        <ResponsiveContainer
          width="100%"
          height={height}
          initialDimension={{ width: 280, height }}
        >
          <LineChart data={series} margin={{ top: 6, right: 6, bottom: 2, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.06)" vertical={false} />
            <XAxis dataKey="timeLabel" hide />
            <YAxis
              width={36}
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'var(--font-mono)' }}
              domain={[0, (max: number) => Math.max(targetFps, Math.ceil((max || targetFps) * 1.15))]}
            />
            {targetFps > 0 && (
              <ReferenceLine
                y={targetFps}
                stroke="rgba(123, 208, 255, 0.32)"
                strokeDasharray="4 4"
              />
            )}
            <Tooltip
              content={createTooltipRenderer('FPS', accentColor, (v) => `${Math.round(v)}`)}
              cursor={{ stroke: 'rgba(255, 255, 255, 0.16)', strokeWidth: 1 }}
            />
            <Line
              type="monotone"
              dataKey="fps"
              stroke={accentColor}
              strokeOpacity={hasData ? 1 : 0.4}
              strokeWidth={2}
              dot={renderEndGlowDot(lastIndex, accentColor, hasData, 3)}
              activeDot={{ r: 4, fill: accentColor, stroke: '#0b0f14', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={axisFooterStyle}>
        <span>{startLabel}</span>
        <span>{midLabel}</span>
        <span>{endLabel}</span>
      </div>
    </div>
  );
};
