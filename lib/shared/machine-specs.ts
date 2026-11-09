/** Hardware of the codespace that hosts a phone. GitHub gives 4 GB of RAM per core. */
export type MachineSpecs = { cores: number; ramGb: number; diskGb: number | null };

export function machineSpecs(machine: string, cores: number | null): MachineSpecs {
  const cpus = cores ?? (machine === "basicLinux32gb" ? 2 : 4);
  const disk = /(\d+)gb$/i.exec(machine);
  return { cores: cpus, ramGb: cpus * 4, diskGb: disk ? Number(disk[1]) : null };
}

export function machineRows(machine: string, cores: number | null): [string, string][] {
  const specs = machineSpecs(machine, cores);
  return [
    ["CPU", `${specs.cores} cores`],
    ["RAM", `${specs.ramGb} GB`],
    ["Disk", specs.diskGb === null ? "Unknown" : `${specs.diskGb} GB`],
  ];
}
