import { AxiosError } from 'axios';
import type { HnetKey, SuciKeysResult, GenerateKeyInput } from '../types/suci';
import { api } from './index';

// These calls used to go out through raw fetch(), which bypassed the shared
// client: no cookie once VITE_API_URL points at another origin, and a session
// that expired mid-use showed "Failed to list SUCI keys" instead of returning
// to the login page like every other screen does.

//Keep the API's own error text, which axios otherwise replaces with
//"Request failed with status code 400"
function apiError(err: unknown, fallback: string): Error {
  const detail = (err as AxiosError<{ error?: string }>)?.response?.data?.error;
  return new Error(detail || fallback);
}

export const suciApi = {
  // List all SUCI keys
  async listKeys(): Promise<SuciKeysResult> {
    try {
      return (await api.get<SuciKeysResult>('/suci/keys')).data;
    } catch (err) {
      throw apiError(err, 'Failed to list SUCI keys');
    }
  },

  // Get next available PKI ID
  async getNextId(): Promise<number> {
    try {
      return (await api.get<{ nextId: number }>('/suci/next-id')).data.nextId;
    } catch (err) {
      throw apiError(err, 'Failed to get next ID');
    }
  },

  // Generate new SUCI key
  async generateKey(input: GenerateKeyInput): Promise<HnetKey> {
    try {
      return (await api.post<HnetKey>('/suci/keys', input)).data;
    } catch (err) {
      throw apiError(err, 'Failed to generate key');
    }
  },

  // Regenerate existing SUCI key
  async regenerateKey(id: number, scheme: 1 | 2): Promise<HnetKey> {
    try {
      return (await api.put<HnetKey>(`/suci/keys/${id}`, { scheme })).data;
    } catch (err) {
      throw apiError(err, 'Failed to regenerate key');
    }
  },

  // Delete SUCI key
  async deleteKey(id: number, deleteFile: boolean): Promise<void> {
    try {
      await api.delete(`/suci/keys/${id}`, { params: { deleteFile } });
    } catch (err) {
      throw apiError(err, 'Failed to delete key');
    }
  },
};
