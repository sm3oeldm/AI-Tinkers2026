// Route-handler guards: every API surface enforces role + ownership server-side.
import { AuthedUser, getCurrentUser } from "./auth";
import { ApiError } from "./http";
import { prisma } from "./db";

export async function requireUser(): Promise<AuthedUser> {
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, "Not signed in");
  return user;
}

export async function requireFaculty(): Promise<AuthedUser> {
  const user = await requireUser();
  if (user.role !== "FACULTY") throw new ApiError(403, "Faculty account required");
  return user;
}

export async function requireStudent(): Promise<AuthedUser> {
  const user = await requireUser();
  if (user.role !== "STUDENT") throw new ApiError(403, "Student account required");
  return user;
}

export async function requireCourseOwner(courseId: string, user: AuthedUser) {
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) throw new ApiError(404, "Course not found");
  if (course.professorId !== user.id) throw new ApiError(403, "That course is not yours");
  return course;
}

export async function requireOwnedExam(examId: string, user: AuthedUser) {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { course: { select: { id: true, professorId: true, code: true, title: true } } },
  });
  if (!exam) throw new ApiError(404, "Exam not found");
  if (exam.course.professorId !== user.id) throw new ApiError(403, "That exam is not yours");
  return exam;
}
