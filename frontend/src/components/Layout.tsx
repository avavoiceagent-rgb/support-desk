import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { Avatar } from "./Avatar";
import { Logo } from "./Logo";

export function Layout() {
  const { user, logout } = useAuth();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
      isActive ? "bg-indigo-600 text-white shadow-sm" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
    }`;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1900px] items-center justify-between px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-6">
            <span className="flex items-center gap-2.5">
              <Logo />
              <span className="text-[17px] font-bold tracking-tight text-gray-900">Support Desk</span>
            </span>
            <nav className="flex gap-1.5">
              <NavLink to="/tickets" className={linkClass}>
                Tickets
              </NavLink>
              <NavLink to="/dashboard" className={linkClass}>
                Dashboard
              </NavLink>
              <NavLink to="/operations" className={linkClass}>
                Operations
              </NavLink>
              <NavLink to="/reports" className={linkClass}>
                Reports
              </NavLink>
              <NavLink to="/settings" className={linkClass}>
                Settings
              </NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {user && (
              <span className="flex items-center gap-2">
                <Avatar name={user.name} size={7} />
                <span className="hidden text-sm font-medium text-gray-700 sm:inline">{user.name}</span>
              </span>
            )}
            <button
              onClick={() => void logout()}
              className="rounded-lg px-2.5 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1900px] px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
