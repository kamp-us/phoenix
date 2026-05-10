import * as React from 'react';
import { Avatar as BaseAvatar } from '@base-ui/react/avatar';
import { bem } from '../../lib/bem';
import './Avatar.css';

const styles = bem('kp-avatar', ['image']);

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

function initialsOf(name: string) {
  return name
    .split(/\s+|_|-/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function Avatar({
  name,
  src,
  size = 'sm',
  className = '',
}: {
  name: string;
  src?: string;
  size?: AvatarSize;
  className?: string;
}) {
  const sizeCls = size === 'sm' ? '' : `kp-avatar--${size}`;
  return (
    <BaseAvatar.Root className={`${styles.root} ${sizeCls} ${className}`.trim()}>
      {src ? <BaseAvatar.Image src={src} alt={name} className={styles.image} /> : null}
      <BaseAvatar.Fallback>{initialsOf(name)}</BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}

