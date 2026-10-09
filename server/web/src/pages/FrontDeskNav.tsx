import { NavLink } from 'react-router-dom';

/** Sub-navigation shared by the Front Desk module's pages. */
export default function FrontDeskNav() {
  return (
    <nav className="subnav" aria-label="Front desk">
      <NavLink to="/front-desk" end>Today</NavLink>
      <NavLink to="/front-desk/patients">Patients</NavLink>
    </nav>
  );
}
