import * as React from 'react';
import { Form as BaseForm } from '@base-ui/react/form';
import { Field as BaseField } from '@base-ui/react/field';
import { Input as BaseInput } from '@base-ui/react/input';
import { bem } from '../../lib/bem';
import './Form.css';

const styles = bem('kp-form', []);
const fieldStyles = bem('kp-field', ['label', 'hint', 'error']);

/* Form root — handles submit + collects errors keyed by Field name. */
export function Form({
  className = '',
  children,
  ...rest
}: React.ComponentProps<typeof BaseForm>) {
  return (
    <BaseForm className={`${styles.root} ${className}`.trim()} {...rest}>
      {children}
    </BaseForm>
  );
}

/* Field root — wires label/control/error via aria-describedby. */
export function Field({
  className = '',
  children,
  ...rest
}: React.ComponentProps<typeof BaseField.Root>) {
  return (
    <BaseField.Root className={`kp-field ${className}`.trim()} {...rest}>
      {children}
    </BaseField.Root>
  );
}

export function Label({ children, ...rest }: React.ComponentProps<typeof BaseField.Label>) {
  return (
    <BaseField.Label className={fieldStyles.label} {...rest}>
      {children}
    </BaseField.Label>
  );
}

export function Hint({ children, ...rest }: React.ComponentProps<typeof BaseField.Description>) {
  return (
    <BaseField.Description className={fieldStyles.hint} {...rest}>
      {children}
    </BaseField.Description>
  );
}

export function Error({ children, ...rest }: React.ComponentProps<typeof BaseField.Error>) {
  return (
    <BaseField.Error className={fieldStyles.error} {...rest}>
      {children}
    </BaseField.Error>
  );
}

/* Input — Base UI Input slot, takes Field control id automatically. */
export function Input({
  className = '',
  ...rest
}: React.ComponentProps<typeof BaseInput>) {
  return <BaseInput className={`kp-input ${className}`.trim()} {...rest} />;
}

/* Textarea — plain element, given a Field's id via render-as. */
export function Textarea({
  className = '',
  mono = false,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  const cls = `kp-textarea ${mono ? 'kp-textarea--mono' : ''} ${className}`.trim();
  return <BaseField.Control render={<textarea className={cls} {...rest} />} />;
}

