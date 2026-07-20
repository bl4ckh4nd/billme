import { useEffect, useState } from 'react';
import { supportedServerRoles, type PlatformTenantSummary, type PlatformTenantUserSummary } from '@billme/server-core';
import { platformClient } from './api/platformClient';

type View = { name: 'login' } | { name: 'workspaces' } | { name: 'workspace'; tenantId: string };

const TOKEN_STORAGE_KEY = 'billme-platform-admin-token';

const LoginScreen = ({ onLoggedIn }: { onLoggedIn: (token: string) => void }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await platformClient.login(email, password);
      sessionStorage.setItem(TOKEN_STORAGE_KEY, response.token);
      onLoggedIn(response.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-shell">
      <h1>Billme Platform Admin</h1>
      <form className="admin-card" onSubmit={handleSubmit}>
        {error ? <div className="admin-error">{error}</div> : null}
        <div className="admin-field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="admin-field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button className="admin-button" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
};

const CreateWorkspaceForm = ({ token, onCreated }: { token: string; onCreated: () => void }) => {
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [product, setProduct] = useState<'lite' | 'pro'>('lite');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerFullName, setOwnerFullName] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await platformClient.createTenant(token, {
        slug,
        displayName,
        product,
        ownerEmail,
        ownerFullName,
        ownerPassword,
      });
      setSlug('');
      setDisplayName('');
      setOwnerEmail('');
      setOwnerFullName('');
      setOwnerPassword('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-card" onSubmit={handleSubmit}>
      <h2>Create workspace</h2>
      {error ? <div className="admin-error">{error}</div> : null}
      <div className="admin-field">
        <label htmlFor="slug">Slug</label>
        <input id="slug" value={slug} onChange={(e) => setSlug(e.target.value)} required />
      </div>
      <div className="admin-field">
        <label htmlFor="displayName">Display name</label>
        <input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
      </div>
      <div className="admin-field">
        <label htmlFor="product">Product</label>
        <select id="product" value={product} onChange={(e) => setProduct(e.target.value as 'lite' | 'pro')}>
          <option value="lite">Lite</option>
          <option value="pro">Pro</option>
        </select>
      </div>
      <div className="admin-field">
        <label htmlFor="ownerEmail">Owner email</label>
        <input id="ownerEmail" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} required />
      </div>
      <div className="admin-field">
        <label htmlFor="ownerFullName">Owner full name</label>
        <input id="ownerFullName" value={ownerFullName} onChange={(e) => setOwnerFullName(e.target.value)} required />
      </div>
      <div className="admin-field">
        <label htmlFor="ownerPassword">Owner password</label>
        <input
          id="ownerPassword"
          type="password"
          minLength={12}
          value={ownerPassword}
          onChange={(e) => setOwnerPassword(e.target.value)}
          required
        />
      </div>
      <button className="admin-button" type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create workspace'}
      </button>
    </form>
  );
};

const WorkspacesScreen = ({ token, onOpenWorkspace }: { token: string; onOpenWorkspace: (tenantId: string) => void }) => {
  const [tenants, setTenants] = useState<PlatformTenantSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setTenants(await platformClient.listTenants(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="admin-shell">
      <h1>Workspaces</h1>
      {error ? <div className="admin-error">{error}</div> : null}
      <div className="admin-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Slug</th>
              <th>Name</th>
              <th>Product</th>
              <th>Status</th>
              <th>Members</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr key={tenant.id}>
                <td>{tenant.slug}</td>
                <td>{tenant.displayName}</td>
                <td>{tenant.product}</td>
                <td>{tenant.status}</td>
                <td>{tenant.memberCount}</td>
                <td>
                  <button className="admin-link" onClick={() => onOpenWorkspace(tenant.id)}>
                    Manage users
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CreateWorkspaceForm token={token} onCreated={refresh} />
    </div>
  );
};

const AddUserForm = ({
  token,
  tenantId,
  onAdded,
}: {
  token: string;
  tenantId: string;
  onAdded: () => void;
}) => {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<(typeof supportedServerRoles)[number]>('viewer');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await platformClient.addTenantUser(token, tenantId, { email, fullName, password, role });
      setEmail('');
      setFullName('');
      setPassword('');
      setRole('viewer');
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add user');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-card" onSubmit={handleSubmit}>
      <h2>Add user</h2>
      {error ? <div className="admin-error">{error}</div> : null}
      <div className="admin-field">
        <label htmlFor="userEmail">Email</label>
        <input id="userEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div className="admin-field">
        <label htmlFor="userFullName">Full name</label>
        <input id="userFullName" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      </div>
      <div className="admin-field">
        <label htmlFor="userPassword">Password</label>
        <input
          id="userPassword"
          type="password"
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <div className="admin-field">
        <label htmlFor="userRole">Role</label>
        <select id="userRole" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
          {supportedServerRoles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <button className="admin-button" type="submit" disabled={busy}>
        {busy ? 'Adding…' : 'Add user'}
      </button>
    </form>
  );
};

const WorkspaceDetailScreen = ({
  token,
  tenantId,
  onBack,
}: {
  token: string;
  tenantId: string;
  onBack: () => void;
}) => {
  const [users, setUsers] = useState<PlatformTenantUserSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setUsers(await platformClient.listTenantUsers(token, tenantId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  return (
    <div className="admin-shell">
      <button className="admin-link" onClick={onBack}>
        &larr; Back to workspaces
      </button>
      <h1>Workspace users</h1>
      {error ? <div className="admin-error">{error}</div> : null}
      <div className="admin-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Full name</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.email}</td>
                <td>{user.fullName}</td>
                <td>{user.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AddUserForm token={token} tenantId={tenantId} onAdded={refresh} />
    </div>
  );
};

const App = () => {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_STORAGE_KEY));
  const [view, setView] = useState<View>({ name: 'workspaces' });

  if (!token) {
    return <LoginScreen onLoggedIn={setToken} />;
  }

  if (view.name === 'workspace') {
    return (
      <WorkspaceDetailScreen
        token={token}
        tenantId={view.tenantId}
        onBack={() => setView({ name: 'workspaces' })}
      />
    );
  }

  return <WorkspacesScreen token={token} onOpenWorkspace={(tenantId) => setView({ name: 'workspace', tenantId })} />;
};

export default App;
