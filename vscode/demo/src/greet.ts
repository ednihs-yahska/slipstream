export interface GreetOptions {
  excited?: boolean;
}

export function greet(name: string, options: GreetOptions = {}): string {
  const greeting = `Hello, ${name}`;
  return options.excited ? `${greeting}!` : `${greeting}.`;
}
