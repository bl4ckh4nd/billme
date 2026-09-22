interface SkeletonLoaderProps {
  variant?: 'card' | 'list' | 'table';
  count?: number;
}

const pulse = 'motion-safe:animate-pulse motion-reduce:animate-none';

export const SkeletonLoader = ({ variant = 'card', count = 3 }: SkeletonLoaderProps) => {
  if (variant === 'card') {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className={`bg-surface border border-border rounded-xl p-6 ${pulse}`}
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
            className={`bg-surface border border-border rounded-lg p-4 flex items-center gap-4 ${pulse}`}
          >
            <div className="w-12 h-12 bg-border rounded-full flex-shrink-0"></div>
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-border rounded-sm w-1/3"></div>
              <div className="h-3 bg-border-subtle rounded-sm w-1/2"></div>
            </div>
            <div className="h-8 w-24 bg-border rounded-sm"></div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'table') {
    return (
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className={pulse}>
          <div className="bg-surface-muted border-b border-border px-6 py-3 flex gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-4 bg-border rounded-sm flex-1"></div>
            ))}
          </div>
          {Array.from({ length: count }).map((_, i) => (
            <div key={i} className="border-b border-border-subtle px-6 py-4 flex gap-4">
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
