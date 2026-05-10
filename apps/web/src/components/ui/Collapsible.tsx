import * as React from 'react';
import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible';
import { bem } from '../../lib/bem';
import './Collapsible.css';

const styles = bem('kp-collapsible', ['trigger', 'panel']);

export const Root = BaseCollapsible.Root;

export function Trigger({
  open,
  className = '',
  ...rest
}: React.ComponentProps<typeof BaseCollapsible.Trigger> & { open?: boolean }) {
  return (
    <BaseCollapsible.Trigger
      className={`${styles.trigger} ${className}`.trim()}
      aria-label={open ? 'Daralt' : 'Genişlet'}
      {...rest}
    >
      {open ? '–' : '+'}
    </BaseCollapsible.Trigger>
  );
}

export function Panel({
  children,
  ...rest
}: React.ComponentProps<typeof BaseCollapsible.Panel>) {
  return (
    <BaseCollapsible.Panel className={styles.panel} {...rest}>
      {children}
    </BaseCollapsible.Panel>
  );
}

export const Collapsible = { Root, Trigger, Panel };
