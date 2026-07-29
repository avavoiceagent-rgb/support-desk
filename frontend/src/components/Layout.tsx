import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export function Layout() {
  const { user, logout } = useAuth();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 rounded-md text-sm font-medium ${
      isActive ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"
    }`;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="text-lg font-semibold text-gray-900">Support Desk</span>
            <nav className="flex gap-1">
              <NavLink to="/tickets" className={linkClass}>
                Tickets
              </NavLink>
              <NavLink to="/settings" className={linkClass}>
                Settings
              </NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-600">
            <span>{user?.name}</span>
            <button
              onClick={() => void logout()}
              className="rounded-md px-2 py-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
