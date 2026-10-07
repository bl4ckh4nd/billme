interface SkeletonLoaderProps {
  variant?: 'card' | 'list' | 'table';
  count?: number;
}

const pulse = 'motion-safe:animate-pulse motion-reduce:animate-none';

export const SkeletonLoader = ({ variant = 'card', count = 3 }: SkeletonLoaderProps) => {
  if (variant === 'card') {
    return (
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className={`rounded-card border border-border bg-surface p-3.5 ${pulse}`}
          >
            <div className="h-4 bg-border rounded-sm w-3/4 mb-3"></div>
            <div className="h-3 bg-border-subtle rounded-sm w-1/2 mb-4"></div>
            <div className="space-y-2">
              <div className="h-3 bg-border-subtle rounded-sm w-full"></div>
              <div className="h-3 bg-border-subtle rounded-sm w-5/6"></div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'list') {
    return (
      <div className="space-y-3">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className={`flex items-center gap-3.25 rounded-card border border-border bg-surface p-3.5 ${pulse}`}
          >
            <div className="size-9 shrink-0 rounded-lg bg-border"></div>
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-border rounded-sm w-1/3"></div>
              <div className="h-3 bg-border-subtle rounded-sm w-1/2"></div>
            </div>
            <div className="h-7 w-20 rounded-control bg-border"></div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'table') {
    return (
      <div className="overflow-hidden rounded-card border border-border bg-surface">
        <div className={pulse}>
          <div className="flex gap-3 border-b border-border bg-surface-muted px-3 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-4 bg-border rounded-sm flex-1"></div>
            ))}
          </div>
          {Array.from({ length: count }).map((_, i) => (
            <div key={i} className="flex gap-3 border-b border-border px-3 py-3 last:border-0">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="h-3 bg-border-subtle rounded-sm flex-1"></div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
};
