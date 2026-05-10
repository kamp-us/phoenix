import * as React from 'react';
import './Footer.css';

export function Footer({ children }: { children?: React.ReactNode }) {
  return (
    <footer className="kp-footer">
      {children ?? (
        <>
          kampüs · <a href="#">manifesto</a> · <a href="#">api</a> · <a href="#">github</a>
        </>
      )}
    </footer>
  );
}

