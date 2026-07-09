'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './auth-context';

export function NavBar() {
  const { isAuthenticated, userName, logout } = useAuth();
  const pathname = usePathname();

  if (!isAuthenticated) return null;

  const links = [
    { href: '/', label: 'Dashboard' },
    { href: '/accounts', label: 'Twitter Accounts' },
    { href: '/experiment', label: 'Experiments' },
    { href: '/data', label: 'Data' },
  ];

  return (
    <nav className="bg-white shadow-sm border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-14">
        <div className="flex items-center gap-1">
          <span className="font-bold text-blue-600 mr-4 text-lg">Exp Platform</span>
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                pathname === link.href
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">User: {userName}</span>
          <button
            onClick={logout}
            className="text-sm text-red-500 hover:text-red-700 px-2 py-1 rounded"
          >
            Logout
          </button>
        </div>
      </div>
    </nav>
  );
}
