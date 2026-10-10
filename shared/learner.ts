export interface LearnerProfile {
  id: string;
  version: string;
  background: string;
  concepts: {
    id: string;
    description: string;
    initial: "known" | "unknown" | "misconception";
    misconception?: string;
  }[];
}
export interface VisibleLesson {
  id: string;
  text: string;
  conceptIds: string[];
}
export interface LearnerTask {
  id: string;
  conceptId: string;
  question: string;
  choices: { id: string; text: string }[];
}
export interface LearnerAnswer {
  choice: string | null;
  explanation: string;
  questions: string[];
  usedVisibleIds: string[];
  selfReportedUnderstanding: boolean;
}
export interface LearnerObservation {
  id: string;
  task: LearnerTask;
  answer: LearnerAnswer;
  assessment: {
    correct: boolean;
    unauthorizedKnowledge: boolean;
    basisAvailable: boolean;
  };
}
export interface LearnerState {
  id: string;
  version: number;
  profile: LearnerProfile;
  concepts: {
    id: string;
    description: string;
    status: "known" | "unknown" | "misconception" | "observed";
    misconception?: string;
    taughtBy: string[];
    evidence: string[];
  }[];
  visible: VisibleLesson[];
  observations: LearnerObservation[];
}
