interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const Spinner = ({ size = 'md', className = '' }: SpinnerProps) => {
  const sizeClasses = {
    sm: 'w-4 h-4 border-2',
    md: 'w-8 h-8 border-3',
    lg: 'w-12 h-12 border-4',
  };

  return (
    <div
      className={`${sizeClasses[size]} border-gray-200 border-t-gray-800 rounded-full animate-spin ${className}`}
      role="status"
      aria-label="Lädt..."
    >
      <span className="sr-only">Lädt...</span>
    </div>
  );
};
