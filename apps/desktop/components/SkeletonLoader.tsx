interface SkeletonLoaderProps {
  variant?: 'card' | 'list' | 'table';
  count?: number;
}

export const SkeletonLoader = ({ variant = 'card', count = 3 }: SkeletonLoaderProps) => {
  if (variant === 'card') {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="bg-white border border-gray-200 rounded-xl p-6 animate-pulse"
          >
            <div className="h-4 bg-gray-200 rounded w-3/4 mb-3"></div>
            <div className="h-3 bg-gray-100 rounded w-1/2 mb-4"></div>
            <div className="space-y-2">
              <div className="h-3 bg-gray-100 rounded w-full"></div>
              <div className="h-3 bg-gray-100 rounded w-5/6"></div>
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
            className="bg-white border border-gray-200 rounded-lg p-4 animate-pulse flex items-center gap-4"
          >
            <div className="w-12 h-12 bg-gray-200 rounded-full flex-shrink-0"></div>
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-gray-200 rounded w-1/3"></div>
              <div className="h-3 bg-gray-100 rounded w-1/2"></div>
            </div>
            <div className="h-8 w-24 bg-gray-200 rounded"></div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'table') {
    return (
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="animate-pulse">
          {/* Header */}
          <div className="bg-gray-50 border-b border-gray-200 px-6 py-3 flex gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-4 bg-gray-200 rounded flex-1"></div>
            ))}
          </div>
          {/* Rows */}
          {Array.from({ length: count }).map((_, i) => (
            <div key={i} className="border-b border-gray-100 px-6 py-4 flex gap-4">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="h-3 bg-gray-100 rounded flex-1"></div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
};
