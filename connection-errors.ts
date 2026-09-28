// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

export class SignInRequired extends Error {
  constructor() {
    super('Datadog sign-in is required. Open /datadog to connect.');
    this.name = 'SignInRequired';
  }
}
export class IdentityMismatch extends Error {
  constructor() {
    super(
      'Datadog authenticated to a different organization. The connection was not changed. Open /datadog to sign in to the saved organization.',
    );
    this.name = 'IdentityMismatch';
  }
}
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
