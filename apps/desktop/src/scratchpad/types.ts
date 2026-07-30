export type ScratchpadListInput = {
  projectPath: string;
};

export type ScratchpadSaveInput = {
  padId: string;
  projectPath: string;
  title: string;
  body: string;
};

export type ScratchpadDeleteInput = {
  padId: string;
};
