import * as React from 'react';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import './Switch.css';

export function Switch({
  className = '',
  ...rest
}: React.ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root className={`kp-switch ${className}`.trim()} {...rest}>
      <BaseSwitch.Thumb className="kp-switch__thumb" />
    </BaseSwitch.Root>
  );
}

