import React from 'react';
import { Titlebar as SharedTitlebar } from '@billme/desktop-renderer/components/Titlebar';
import billmeMarkLogo from '../assets/billme-mark.svg';

export const Titlebar: React.FC = () => <SharedTitlebar logoSrc={billmeMarkLogo} />;
