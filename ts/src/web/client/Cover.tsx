import type { Artwork } from '../api';

/**
 * A square album cover. While art is unknown, or when Spotify has none, it
 * shows the album's initial on a plain tile so the layout never shifts.
 */
export function Cover({
  art,
  size,
  albumName,
  className,
}: {
  art: Artwork | null | undefined;
  size: 'small' | 'large';
  albumName: string;
  className?: string;
}) {
  const url = size === 'small' ? (art?.small ?? art?.medium ?? art?.large) : (art?.large ?? art?.medium ?? art?.small);
  const classes = `cover cover--${size}${className === undefined ? '' : ` ${className}`}`;
  if (url === undefined || url === null) {
    return (
      <div className={`${classes} cover--empty`} aria-hidden="true">
        <span>{[...albumName.trim()][0] ?? '♪'}</span>
      </div>
    );
  }
  // `key` restarts the fade whenever the image changes.
  return <img key={url} className={classes} src={url} alt={`Cover of ${albumName}`} loading="lazy" decoding="async" />;
}
