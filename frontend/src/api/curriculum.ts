/** 课程大纲 API */
import apiClient from './client';
import type {
  Course,
  CourseCreateRequest,
  ChapterCreateRequest,
  KnowledgePointCreateRequest,
  KnowledgePoint,
  BindingCreateRequest,
  CurriculumResource,
  ProgressStats,
} from '../types';

/** 获取完整课程树（学生视图含进度） */
export async function getCurriculumTree(): Promise<Course[]> {
  const { data } = await apiClient.get('/api/curriculum/tree');
  return data;
}

/** 获取课程列表 */
export async function listCourses(params?: {
  grade?: string;
  status?: string;
}): Promise<{ courses: Course[]; total: number }> {
  const { data } = await apiClient.get('/api/curriculum/courses', { params });
  return data;
}

/** 获取课程详情（含树结构） */
export async function getCourse(courseId: number): Promise<Course> {
  const { data } = await apiClient.get(`/api/curriculum/courses/${courseId}`);
  return data;
}

/** 创建课程 */
export async function createCourse(req: CourseCreateRequest): Promise<{ message: string; course_id: number }> {
  const { data } = await apiClient.post('/api/curriculum/courses', req);
  return data;
}

/** 更新课程 */
export async function updateCourse(courseId: number, updates: Partial<CourseCreateRequest>): Promise<{ message: string }> {
  const { data } = await apiClient.put(`/api/curriculum/courses/${courseId}`, updates);
  return data;
}

/** 删除课程 */
export async function deleteCourse(courseId: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete(`/api/curriculum/courses/${courseId}`);
  return data;
}

/** 获取章节详情 */
export async function getChapter(chapterId: number): Promise<any> {
  const { data } = await apiClient.get(`/api/curriculum/chapters/${chapterId}`);
  return data;
}

/** 创建章节 */
export async function createChapter(req: ChapterCreateRequest): Promise<{ message: string; chapter_id: number }> {
  const { data } = await apiClient.post('/api/curriculum/chapters', req);
  return data;
}

/** 更新章节 */
export async function updateChapter(chapterId: number, updates: Partial<ChapterCreateRequest>): Promise<{ message: string }> {
  const { data } = await apiClient.put(`/api/curriculum/chapters/${chapterId}`, updates);
  return data;
}

/** 删除章节 */
export async function deleteChapter(chapterId: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete(`/api/curriculum/chapters/${chapterId}`);
  return data;
}

/** 获取知识点详情 */
export async function getKnowledgePoint(kpId: number): Promise<KnowledgePoint> {
  const { data } = await apiClient.get(`/api/curriculum/knowledge-points/${kpId}`);
  return data;
}

/** 创建知识点 */
export async function createKnowledgePoint(req: KnowledgePointCreateRequest): Promise<{ message: string; kp_id: number }> {
  const { data } = await apiClient.post('/api/curriculum/knowledge-points', req);
  return data;
}

/** 更新知识点 */
export async function updateKnowledgePoint(kpId: number, updates: Partial<KnowledgePointCreateRequest>): Promise<{ message: string }> {
  const { data } = await apiClient.put(`/api/curriculum/knowledge-points/${kpId}`, updates);
  return data;
}

/** 删除知识点 */
export async function deleteKnowledgePoint(kpId: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete(`/api/curriculum/knowledge-points/${kpId}`);
  return data;
}

/** 获取知识点绑定的资源列表 */
export async function getKpResources(kpId: number): Promise<{ resources: CurriculumResource[]; total: number }> {
  const { data } = await apiClient.get(`/api/curriculum/knowledge-points/${kpId}/resources`);
  return data;
}

/** 绑定资源到知识点 */
export async function bindResource(req: BindingCreateRequest): Promise<{ message: string; binding_id: number }> {
  const { data } = await apiClient.post('/api/curriculum/bindings', req);
  return data;
}

/** 解绑资源 */
export async function unbindResource(bindingId: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete(`/api/curriculum/bindings/${bindingId}`);
  return data;
}

/** 获取可绑定的候选资源 */
export async function getAvailableResources(params: {
  resource_type: string;
  keyword?: string;
  kp_id?: number;
}): Promise<{ resources: { id: number; name: string }[]; total: number }> {
  const { data } = await apiClient.get('/api/curriculum/bindings/available', { params });
  return data;
}

/** 获取我的学习进度 */
export async function getMyProgress(): Promise<{ progress: any[]; total: number }> {
  const { data } = await apiClient.get('/api/curriculum/progress');
  return data;
}

/** 更新知识点学习状态 */
export async function updateProgress(kpId: number, status: string, score?: number): Promise<{ message: string }> {
  const { data } = await apiClient.put(`/api/curriculum/progress/${kpId}`, { status, score });
  return data;
}

/** 获取课程维度进度统计 */
export async function getProgressStats(courseId?: number): Promise<{ stats?: ProgressStats[] } | ProgressStats> {
  const { data } = await apiClient.get('/api/curriculum/progress/stats', {
    params: courseId ? { course_id: courseId } : {},
  });
  return data;
}

/** 获取班级进度总览（教师用） */
export async function getClassProgressOverview(params?: {
  course_id?: number;
  grade?: string;
  class_name?: string;
}): Promise<{ students: any[]; total: number }> {
  const { data } = await apiClient.get('/api/curriculum/progress/overview', { params });
  return data;
}
