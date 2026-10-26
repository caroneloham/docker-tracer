import React, { useState } from 'react';
import { containerBrand } from '../shared/container-brands.mjs';
import brandAssets from './brand-assets.js';
import './equipment-icon.css';

// Original equipment drawings: a compact, classic network editor vocabulary.
export default function EquipmentIcon({ kind = 'server', image, className = '' }) {
  const brand = kind === 'network' || kind === 'router' ? null : containerBrand(image);
  const asset = brand && brandAssets[brand.id];
  const [failedAsset, setFailedAsset] = useState(null);
  if (asset && failedAsset !== asset) {
    return (
      <img
        className={`equipment-icon equipment-brand-icon ${className}`}
        src={asset}
        alt={brand.label}
        title={brand.label}
        width="60"
        height="48"
        draggable={false}
        onError={() => setFailedAsset(asset)}
      />
    );
  }
  return (
    <svg className={`equipment-icon ${className}`} viewBox="0 0 64 52" aria-hidden="true">
      {kind === 'network' ? (
        <g stroke="#397d91" strokeWidth="1">
          <path d="M5 25 20 14 59 17 46 29Z" fill="#83c1cf" />
          <path d="M5 25 46 29 46 40 5 35Z" fill="#4c94a7" />
          <path d="M46 29 59 17 59 29 46 40Z" fill="#34788c" />
          <path
            d="m18 21 8-3m-5 0 5 0-2 3m12 4 8-3m-5 0 5 0-2 3m-13-1-8 3m5 0-5 0 2-3m28-4-8 3m5 0-5 0 2-3"
            stroke="#e1f6f7"
            fill="none"
          />
          {[10, 17, 24, 31, 38].map((x) => (
            <path key={x} d={`M${x} 29v4h4v-4Z`} fill="#153f52" />
          ))}
          <path d="m49 30 6-5" stroke="#a7dcec" />
        </g>
      ) : kind === 'router' ? (
        <g stroke="#397d91" strokeWidth="1">
          <path d="M8 20v15c0 13 48 13 48 0V20" fill="#4c94a7" />
          <ellipse cx="32" cy="20" rx="24" ry="11" fill="#87c4d1" />
          <path
            d="m16 20 10-5m-6 0h6v4m22 1-10 5m6 0h-6v-4m-8-8 9 4m-4-4 4 4-5 1m-4 7-9-4m4 4-4-4 5-1"
            fill="none"
            stroke="#e7f7f9"
            strokeWidth="1.8"
          />
          <path d="M16 35v4h5v-4Zm9 2v4h5v-4Zm9 0v4h5v-4Z" fill="#153f52" />
          <circle cx="46" cy="36" r="1.5" fill="#b3eb7b" />
        </g>
      ) : kind === 'terminal' ? (
        <g stroke="#427e90" strokeWidth="1">
          <path d="M12 5h38l-3 29H9Z" fill="#70acbd" />
          <path d="M16 8h30l-2 22H13Z" fill="#d4eef0" />
          <path d="M17 9h27l-1 3H17Z" fill="#edfafa" stroke="none" />
          <path d="M25 35h10v6H22Z" fill="#82bbc5" />
          <path d="m13 40 33 1 8 6H6Z" fill="#a8d0d6" />
          <path d="m12 43 33 1m-28 2h22" stroke="#6b9eab" />
          <path d="m17 17 4 3-4 3m8 0h7" fill="none" stroke="#52909d" />
        </g>
      ) : (
        <g stroke="#427e90" strokeWidth="1">
          <path d="M20 5 39 3 47 9 28 12Z" fill="#acd5dc" />
          <path d="M20 5 28 12v37l-8-6Z" fill="#78afbf" />
          <path d="m28 12 19-3v37l-19 3Z" fill="#5294a9" />
          <path d="m31 16 12-2v4l-12 2Zm0 7 12-2v4l-12 2Z" fill="#c4e6e9" />
          <path d="m32 37 9-1m-9 4 9-1m-9 4 9-1" stroke="#2e6c81" />
          <circle cx="40" cy="31" r="1.7" fill="#b3eb7b" stroke="#427d67" />
          {kind === 'globe' && (
            <g stroke="#336f92">
              <circle cx="47" cy="37" r="9" fill="#b9e0ed" />
              <ellipse cx="47" cy="37" rx="4" ry="9" fill="none" />
              <path d="M38 37h18m-16-5h14m-14 10h14" />
            </g>
          )}
          {kind === 'database' && (
            <g stroke="#567b87">
              <path d="M39 34v12c0 5 20 5 20 0V34" fill="#a9d1d7" />
              <ellipse cx="49" cy="34" rx="10" ry="4" fill="#d8eef0" />
              <path d="M39 40c0 5 20 5 20 0" fill="none" />
            </g>
          )}
        </g>
      )}
    </svg>
  );
}
