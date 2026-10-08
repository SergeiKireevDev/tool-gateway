/** A port the host publishes on its loopback interface, forwarded to a service box. */
export interface PublishedPort {
  /** Port the service listens on inside its VM. */
  port: number;
  /** Port on the host's 127.0.0.1 (where tunnels and local clients connect). */
  hostPort: number;
}

/** What the admin asks vmd to boot: a long-lived VM from a service image. */
export interface ServiceSpec {
  /** Unique among running services; how agents and admins refer to it. */
  name: string;
  /** A built service image (`deploy/services/<image>/Dockerfile`). */
  image: string;
  vcpus: number;
  memMib: number;
  /** Agent VMs may reach its published ports (on the gateway's VM address), not only the host. */
  agentAccess: boolean;
  publish: PublishedPort[];
}

export interface ServiceInfo extends ServiceSpec {
  serviceId: string;
  /** The service VM's address on the VM bridge (reachable from the host only). */
  address: string;
  /** `host:port` agent VMs connect to (the gateway's VM address), one per published port. */
  agentEndpoints: string[];
  /** Ports the image exposes (its Dockerfile's `EXPOSE`). */
  ports: number[];
  /** False once the VM stopped (its command exited); it stays listed until stopped. */
  running: boolean;
  startedAt: string;
}

/** A built service image, as `deploy/build-service-image.sh` installs it. */
export interface ServiceImage {
  name: string;
  ports: number[];
}

/** Boots and stops service boxes (vmd); runs never see them. */
export interface ServiceDriver {
  createService(spec: ServiceSpec): Promise<ServiceInfo>;
  /** Idempotent: stopping an unknown service succeeds. */
  destroyService(serviceId: string): Promise<void>;
  listServices(): Promise<ServiceInfo[]>;
  listServiceImages(): Promise<ServiceImage[]>;
}
