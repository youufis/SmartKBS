/** 资源中心 API */
import apiClient from './client';
import type { ResourceFile, TreeNode } from '../types';

export async function listResources(): Promise<{ files: ResourceFile[]; html_dir: string }> {
  const { data } = await apiClient.get('/api/resources/list');
  return data;
}

export async function getResourceTree(): Promise<{ tree: TreeNode[]; root: string }> {
  const { data } = await apiClient.get('/api/resources/tree');
  return data;
}

export async function uploadResource(files: FileList): Promise<{ message: string; uploaded: string[]; errors: string[] }> {
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append(`file${i}`, files[i]);
    formData.append(`path${i}`, '');
  }
  const { data } = await apiClient.post('/api/resources/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function deleteResource(path: string): Promise<string> {
  const { data } = await apiClient.delete('/api/resources/file', { params: { path } });
  return data.message;
}



export async function renameResource(path: string, new_name: string): Promise<string> {
  const { data } = await apiClient.put('/api/resources/rename', { path, new_name });
  return data.message;
}
