// Samuhia Payments logo. Files live in /public/brand (exported from the Samuhia logo studio).
import React from 'react';

type Variant = 'lockup' | 'lockup-dark' | 'icon' | 'mark';

const FILES: Record<Variant, string> = {
  lockup: '/brand/samuhia-payments-lockup.svg',
  'lockup-dark': '/brand/samuhia-payments-lockup-dark.svg',
  icon: '/brand/samuhia-payments-icon.svg',
  mark: '/brand/samuhia-payments-mark.svg',
};

interface BrandLogoProps {
  variant?: Variant;
  className?: string;
}

const BrandLogo: React.FC<BrandLogoProps> = ({ variant = 'lockup', className = 'h-10 w-auto' }) => (
  <img src={FILES[variant]} alt="Samuhia Payments" className={className} draggable={false} />
);

export default BrandLogo;
