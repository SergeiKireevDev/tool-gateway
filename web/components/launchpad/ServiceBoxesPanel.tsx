'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Api, ApiError } from '@/lib/api';
import { parsePublish, type ServiceBox, type ServiceImage } from '@/lib/launchpad';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, Select } from '../ui';

const HTTP_NOT_FOUND = 404;
const DEFAULT_MEM_MIB = 1024;
/** Suggested host port for an exposed one: 10000 above it when that is a valid port. */
const HOST_PORT_OFFSET = 10_000;
const MAX_PORT = 65_535;

const suggestPublish = (image: ServiceImage | undefined): string =>
  (image?.ports ?? [])
    .map((p) => `${p}:${p + HOST_PORT_OFFSET <= MAX_PORT ? p + HOST_PORT_OFFSET : p}`)
    .join(', ');

function LaunchServiceForm({
  api,
  images,
  onLaunched,
}: {
  api: Api;
  images: ServiceImage[];
  onLaunched: () => void;
}) {
  const [image, setImage] = useState(images[0]?.name ?? '');
  const [name, setName] = useState('');
  const [publish, setPublish] = useState(suggestPublish(images[0]));
  const [vcpus, setVcpus] = useState(1);
  const [memMib, setMemMib] = useState(DEFAULT_MEM_MIB);
  const [agentAccess, setAgentAccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = (): void => {
    const ports = parsePublish(publish);
    if (!ports) {
      setError('Published ports: "service port:host port", comma-separated');
      return;
    }
    const body = { image, vcpus, memMib, agentAccess, publish: ports, ...(name ? { name } : {}) };
    api('POST', '/launchpad/services', body).then(
      () => {
        setError(null);
        setName('');
        onLaunched();
      },
      (err: unknown) => {
        setError((err as Error).message);
      },
    );
  };

  if (images.length === 0) {
    return (
      <EmptyState title="No service images">
        Build one from deploy/services/&lt;name&gt;/Dockerfile with deploy/build-service-image.sh
        and install it in vmd&apos;s service directory.
      </EmptyState>
    );
  }
  return (
    <Card className="p-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Image">
          <Select
            value={image}
            onChange={(e) => {
              setImage(e.target.value);
              setPublish(suggestPublish(images.find((i) => i.name === e.target.value)));
            }}
          >
            {images.map((i) => (
              <option key={i.name} value={i.name}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" hint="Defaults to the image name; unique among running services.">
          <Input
            value={name}
            placeholder={image}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </Field>
        <Field label="Published ports" hint="service port:host port, served on 127.0.0.1.">
          <Input
            value={publish}
            placeholder="8080:18080"
            onChange={(e) => {
              setPublish(e.target.value);
            }}
          />
        </Field>
        <Field label="vCPUs">
          <Input
            type="number"
            min={1}
            value={vcpus}
            onChange={(e) => {
              setVcpus(Number(e.target.value));
            }}
          />
        </Field>
        <Field label="Memory (MiB)">
          <Input
            type="number"
            min={256}
            value={memMib}
            onChange={(e) => {
              setMemMib(Number(e.target.value));
            }}
          />
        </Field>
        <Field label="Agents" hint="Every agent VM can reach its published ports.">
          <label className="flex items-center gap-2 py-2 text-sm">
            <input
              type="checkbox"
              checked={agentAccess}
              onChange={(e) => {
                setAgentAccess(e.target.checked);
              }}
            />
            Open to agents
          </label>
        </Field>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4">
        <ErrorBanner message={error} />
        <Button onClick={launch}>Start service</Button>
      </div>
    </Card>
  );
}

function ServiceList({
  api,
  services,
  onStopped,
}: {
  api: Api;
  services: ServiceBox[];
  onStopped: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const stop = (s: ServiceBox): void => {
    api('DELETE', `/launchpad/services/${s.serviceId}`).then(onStopped, (err: unknown) => {
      setError((err as Error).message);
    });
  };
  if (services.length === 0) return <EmptyState title="No service boxes running" />;
  return (
    <Card className="overflow-x-auto">
      <ErrorBanner message={error} />
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
          <tr>
            <th className="px-4 py-3">Service</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Local</th>
            <th className="px-4 py-3">Agents</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {services.map((s) => (
            <tr key={s.serviceId}>
              <td className="px-4 py-2.5">
                <span className="font-medium">{s.name}</span>{' '}
                <span className="text-xs text-slate-500">
                  {s.image} · {s.address}
                </span>
              </td>
              <td className="px-4 py-2.5">
                {s.running ? (
                  <Badge tone="green">Running</Badge>
                ) : (
                  <Badge tone="red">Stopped</Badge>
                )}
              </td>
              <td className="px-4 py-2.5 font-mono text-xs">
                {s.publish.map((p) => `127.0.0.1:${p.hostPort} → ${p.port}`).join(', ') || '—'}
              </td>
              <td className="px-4 py-2.5 font-mono text-xs">
                {s.agentEndpoints.join(', ') || '—'}
              </td>
              <td className="px-4 py-2.5 text-right">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    stop(s);
                  }}
                >
                  Stop
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Admin: long-lived service boxes (Firecracker driver only). */
export function ServiceBoxesPanel({ api }: { api: Api }) {
  const [services, setServices] = useState<ServiceBox[]>([]);
  const [images, setImages] = useState<ServiceImage[] | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([
        api<ServiceBox[]>('GET', '/launchpad/services'),
        api<ServiceImage[]>('GET', '/launchpad/services/images'),
      ]).then(
        ([s, i]) => {
          setServices(s);
          setImages(i);
          setError(null);
        },
        (err: unknown) => {
          if (err instanceof ApiError && err.status === HTTP_NOT_FOUND) setOff(true);
          else setError((err as Error).message);
        },
      ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (off) {
    return (
      <EmptyState title="Service boxes are off">
        They need the Firecracker VM driver (LAUNCHPAD_VM_DRIVER=firecracker).
      </EmptyState>
    );
  }
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-slate-500">
        Long-lived VMs built from a Dockerfile (deploy/services) that serve a test service until
        stopped: on the host&apos;s loopback (point a tunnel there) and, when open to them, to agent
        VMs.
      </p>
      <ErrorBanner message={error} />
      <ServiceList api={api} services={services} onStopped={() => void load()} />
      {images && <LaunchServiceForm api={api} images={images} onLaunched={() => void load()} />}
    </div>
  );
}
