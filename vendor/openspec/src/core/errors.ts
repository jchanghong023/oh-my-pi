export type OpenSpecDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface OpenSpecDiagnostic {
  severity: OpenSpecDiagnosticSeverity;
  code: string;
  message: string;
  target?: string;
  fix?: string;
}

export class OpenSpecError extends Error {
  readonly diagnostic: OpenSpecDiagnostic;

  constructor(
    message: string,
    code: string,
    options: { target?: string; fix?: string } = {}
  ) {
    super(message);
    this.name = 'OpenSpecError';
    this.diagnostic = {
      severity: 'error',
      code,
      message,
      ...options,
    };
  }
}

export function makeOpenSpecDiagnostic(
  severity: OpenSpecDiagnosticSeverity,
  code: string,
  message: string,
  options: { target?: string; fix?: string } = {}
): OpenSpecDiagnostic {
  return {
    severity,
    code,
    message,
    ...options,
  };
}
