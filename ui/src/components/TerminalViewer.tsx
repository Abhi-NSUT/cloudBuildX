import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { io, Socket } from 'socket.io-client';
import axios from 'axios';
import '@xterm/xterm/css/xterm.css';

interface TerminalViewerProps {
  buildId: string;
  initialStatus: string;
  onStatusChange?: (status: string) => void;
  onBuildComplete?: (status: string) => void;
}

export const TerminalViewer: React.FC<TerminalViewerProps> = ({ buildId, initialStatus, onStatusChange, onBuildComplete }) => {
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!terminalRef.current || !buildId) return;

    // 1. Initialize Terminal instance
    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
      },
      fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      disableStdin: true,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    
    // Ensure container dimensions are calculated before fitting
    setTimeout(() => {
      fitAddon.fit();
    }, 50);

    const token = localStorage.getItem('token');

    if (initialStatus === 'SUCCESS' || initialStatus === 'FAILED' || initialStatus === 'CANCELLED') {
      // Fetch historical logs
      term.writeln('\x1b[33m[SYSTEM] Fetching historical logs...\x1b[0m\r');
      if (onStatusChange) onStatusChange('COMPLETED');
      
      axios.get(`http://localhost:3000/api/builds/${buildId}/logs`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      .then(res => {
        // Write the raw text directly to the terminal
        term.writeln('');
        // Ensure all newlines are \r\n for xterm formatting
        term.write(res.data.replace(/\r?\n/g, '\r\n'));
        term.writeln('\r\n\x1b[32m[SYSTEM] Historical log loaded.\x1b[0m\r');
      })
      .catch(err => {
        term.writeln(`\r\n\x1b[31m[SYSTEM] Failed to load historical logs: ${err.response?.data?.error || err.message}\x1b[0m\r`);
      });

      // Handle viewport adjustments
      const handleResize = () => fitAddon.fit();
      window.addEventListener('resize', handleResize);

      return () => {
        window.removeEventListener('resize', handleResize);
        term.dispose();
      };
    }

    // Otherwise, establish WebSocket Connection for live streaming
    term.writeln('\x1b[33m[SYSTEM] Initializing stream pipeline...\x1b[0m\r');
    
    const socket: Socket = io('http://localhost:3000', {
      auth: { token: `Bearer ${token}` }
    });

    socket.on('connect', () => {
      term.writeln('\x1b[32m[SYSTEM] Connected to WebSocket gateway.\x1b[0m\r');
      term.writeln(`\x1b[36m[SYSTEM] Subscribing to build ID: ${buildId}\x1b[0m\r\n`);
      
      if (onStatusChange) onStatusChange('STREAMING');
      
      socket.emit('subscribeToBuild', buildId);
    });

    // 3. Process Inbound Log Chunks
    socket.on('build-log', (data: { type: string; text: string }) => {
      // Normalize lines to ensure carriage returns for canvas positioning
      const formattedText = data.text.replace(/\r?\n/g, '\r\n');

      if (data.type === 'error') {
        term.writeln(`\x1b[31m${formattedText}\x1b[0m\r`);
      } else if (data.type === 'system') {
        term.writeln(`\r\n\x1b[35m[SYSTEM EVENT] ${formattedText}\x1b[0m\r\n`);
        
        let finalStatus: string | null = null;
        if (formattedText.includes('completed')) finalStatus = 'SUCCESS';
        else if (formattedText.includes('cancelled')) finalStatus = 'CANCELLED';
        else if (formattedText.includes('failed')) finalStatus = 'FAILED';

        if (finalStatus) {
          if (onStatusChange) onStatusChange(finalStatus);
          if (onBuildComplete) onBuildComplete(finalStatus);
        }
      } else {
        term.writeln(`${formattedText}\r`);
      }
    });

    socket.on('disconnect', () => {
      term.writeln('\r\n\x1b[31m[SYSTEM] Connection terminated.\x1b[0m\r');
      if (onStatusChange) onStatusChange('DISCONNECTED');
    });

    // Handle viewport adjustments
    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    // 4. Memory Leak Prevention / Cleanup
    return () => {
      socket.disconnect();
      window.removeEventListener('resize', handleResize);
      term.dispose();
    };
  }, [buildId]);

  return (
    <div className="w-full h-full p-2 bg-[#0d1117] rounded-lg overflow-hidden border border-gray-800 shadow-inner">
      <div ref={terminalRef} className="w-full h-full" />
    </div>
  );
};
