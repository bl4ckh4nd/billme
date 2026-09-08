import React from 'react';
import { createPortal } from 'react-dom';

export interface PortalProps {
  children: React.ReactNode;
}

export const Portal: React.FC<PortalProps> = ({ children }) => {
  if (typeof document === 'undefined') return null;

  return createPortal(children, document.body);
};
