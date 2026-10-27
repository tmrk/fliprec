import { memo } from 'react';
import './Header.css';

const Header = memo(function Header() {
  return (
    <header className="fr-header">
      <svg className="fr-header__mark" viewBox="0 0 32 32" aria-hidden="true">
        <circle className="fr-header__ring" cx="16" cy="16" r="13.2" />
        <circle className="fr-header__disc" cx="16" cy="16" r="8.3" />
        <path className="fr-header__cut" d="M18.7 12.15 12.9 16l5.8 3.85z" />
      </svg>
      <span className="fr-header__name">FlipRec</span>
    </header>
  );
});

export default Header;
