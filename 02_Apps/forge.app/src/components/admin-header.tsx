import { Link } from "@tanstack/react-router";

export function AdminHeader({ title }: { title: string }) {
  return (
    <header className="space-y-3">
      <nav className="flex gap-5 text-sm">
        <Link to="/" className="underline">
          Projects
        </Link>
        <Link to="/admin/runs" className="underline">
          Provisioning runs
        </Link>
        <Link to="/admin/tasks" className="underline">
          Tasks
        </Link>
      </nav>
      <h1 className="text-3xl font-semibold">{title}</h1>
    </header>
  );
}
