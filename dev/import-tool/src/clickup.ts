import core, {
  type Class,
  collaborativeDocParse,
  type Data,
  generateId,
  makeCollaborativeDoc,
  type Ref,
  type Timestamp,
  type TxOperations
} from '@hcengineering/core'
import { type FileUploader } from './fileUploader'
import document, { getFirstRank, type Document, type Teamspace } from '@hcengineering/document'
import tracker, {
  type Issue,
  type IssueStatus,
  type Project,
  TimeReportDayType
} from '@hcengineering/tracker'
import { jsonToYDocNoSchema, parseMessageMarkdown } from '@hcengineering/text'
import { yDocToBuffer } from '@hcengineering/collaboration'
import { readdir } from 'fs/promises'
import { join, parse } from 'path'
import csv from 'csvtojson'
import task, { createProjectType, makeRank, type ProjectType, type Task, type TaskType } from '@hcengineering/task'
import { importIssue, type ImportIssue as ImportIssueOld } from './importer/utils'
import { ImportComment, ImportIssue, ImportProject, ImportProjectType, ImportSpace, ImportWorkspace, WorkspaceImporter } from './importer/importer'

interface ClickupTask {
  'Task ID': string
  'Task Name': string
  'Task Content': string
  Status: string
  'Parent ID': string
  Attachments: string
  Assignees: string
  Priority?: number
  'Space Name': string
  Checklists: string // todo: obj
  Comments: string // todo: obj[]
  'Time Estimated': number
  'Time Spent': number
}

interface ClickupComment {
  by: string
  date: Timestamp
  text: string
}

interface ClickupAttachment {
  title: string
  url: string
}

interface ImportIssueEx extends ImportIssue {
  clickupParentId?: string
  clickupProjectName?: string
}

const CLICKUP_PROJECT_TYPE_ID = generateId<ProjectType>()
const CLICKUP_TASK_TYPE_ID = generateId<TaskType>()
const CLICKUP_MIXIN_ID = `${CLICKUP_TASK_TYPE_ID}:type:mixin` as Ref<Class<Task>>

export async function importClickUp (
  client: TxOperations,
  uploadFile: FileUploader,
  dir: string
): Promise<void> {
  const files = await readdir(dir, { recursive: true })
  console.log(files)

  for (const file of files) {
    const parsedFileName = parse(file)
    const extension = parsedFileName.ext.toLowerCase()
    const fullPath = join(dir, file)
    if (extension === '.md') {
      console.log ("MD Document")
    } else if (extension === '.csv') {
      console.log ("CSV Tasks")
      await processClickupTasks(fullPath, client, uploadFile)
    }
  }
}

async function processTasksCsv (file: string, process: (json: ClickupTask) => Promise<void> | void): Promise<void> {
  const jsonArray = await csv().fromFile(file)
  for (const json of jsonArray) {
    const clickupTask = json as ClickupTask
    await process(clickupTask)
  }
}

async function processClickupTasks (
  file: string,
  client: TxOperations,
  uploadFile: (id: string, data: any) => Promise<any>
): Promise<void> {
  const importIssuesByClickupId = new Map<string, ImportIssueEx>()
  const statuses = new Set<string>()
  const projects = new Set<string>()

  await processTasksCsv(file, async (clickupTask) => {
    const importIssue = await convertToImportIssue(clickupTask) as ImportIssueEx
    importIssue.clickupParentId = clickupTask['Parent ID']
    importIssuesByClickupId.set(clickupTask['Task ID'], importIssue)
    
    statuses.add(clickupTask.Status)
    projects.add(clickupTask['Space Name'])
  })

  const importProjectType = createClickupProjectType(Array.from(statuses))

  const importProjectsByName = new Map<string, ImportProject>()
  for (const projectName of projects) {
    importProjectsByName.set(projectName, {
      class: 'tracker.class.Project',
      name: projectName,
      identifier: projectName.toUpperCase(),
      private: false,
      autoJoin: false,
      projectType: importProjectType,
      docs: []
    })
  }

  for (const [clickupId, issue] of importIssuesByClickupId) {
    if (issue.clickupParentId !== undefined) {
      const parent = importIssuesByClickupId.get(issue.clickupParentId)
      if (parent === undefined) {
        throw new Error(`Parent not found: ${issue.clickupParentId} (for task: ${clickupId})`)
      }
      parent.subdocs.push(issue)
    } else if (issue.clickupProjectName !== undefined) {
      const project = importProjectsByName.get(issue.clickupProjectName)
      if (project === undefined) {
        throw new Error(`Project not found: ${issue.clickupProjectName} (for task: ${clickupId})`)
      }
      project.docs.push(issue)
    } else {
      throw new Error(`Task cannot be imported: ${clickupId} (No parent)` )
    }
  }

  const importClickupData = {
    persons: [],
    spaces: Array.from(importProjectsByName.values()),
    projectTypes: [importProjectType]
  }

  new WorkspaceImporter(client, uploadFile, importClickupData).performImport()
}

async function convertToImportIssue (clickup: ClickupTask): Promise<ImportIssue> {
  const status = {
    name: clickup.Status
  }

  const content = fixMultilineString(clickup['Task Content'])
  const checklists = convertChecklistsToMarkdown(clickup.Checklists)

  const estimation = clickup['Time Estimated']
  const remainingTime = estimation - clickup['Time Spent']

  const comments = convertToImportComments(clickup.Comments)
  // const attachments = await convertAttachmentsToComment(clickup.Attachments)

  const description = `${content}\n\n---\n${checklists}` // todo: test all the combinations
  return {
    class: 'tracker.class.Issue',
    title: '[' + clickup['Task ID'] + '] ' + clickup['Task Name'],
    descrProvider: () => { return Promise.resolve(description) },
    status,
    estimation,
    remainingTime,
    comments,
    subdocs: []
  }
}

function convertToImportComments (clickup: string): ImportComment[] {
  return JSON.parse(clickup).map((comment: ClickupComment) => {
    return {
      text: comment.text,
      date: new Date(comment.date).getTime()
    }
  })
}

function convertChecklistsToMarkdown (clickup: string): string {
  const checklists = JSON.parse(clickup)
  let huly: string = '\n'
  for (const [key, values] of Object.entries(checklists)) {
    huly += `**${key}**\n`
    for (const value of values as string[]) {
      huly += `* [ ] ${value} \n` // todo: test and fix for checked items
    }
    huly += '\n'
  }
  return huly
}

function fixMultilineString (content: string) {
  return content.split('\\n').join('\n')
}

async function importPageDocument (
  client: TxOperations,
  uploadFile: FileUploader,
  name: string,
  data: Buffer,
  space: Ref<Teamspace>
): Promise<void> {
  const md = data.toString() ?? ''
  const json = parseMessageMarkdown(md ?? '', 'image://')

  const id = generateId<Document>()
  const collabId = makeCollaborativeDoc(id, 'description')
  const yDoc = jsonToYDocNoSchema(json, 'content')
  const { documentId } = collaborativeDocParse(collabId)
  const buffer = yDocToBuffer(yDoc)

  const form = new FormData()
  const file = new File([new Blob([buffer])], name)
  form.append('file', file, documentId)
  form.append('type', 'application/ydoc')
  form.append('size', buffer.length.toString())
  form.append('name', name)
  form.append('id', id)
  form.append('data', new Blob([buffer])) // ?

  await uploadFile(id, form)

  const parent = document.ids.NoParent
  const lastRank = await getFirstRank(client, space, parent)
  const rank = makeRank(lastRank, undefined)

  const attachedData: Data<Document> = {
    title: name,
    description: collabId,
    parent,
    attachments: 0,
    embeddings: 0,
    labels: 0,
    comments: 0,
    references: 0,
    rank
  }

  await client.createDoc(document.class.Document, space, attachedData, id)
}

export interface ClickupIssue extends Issue {
  clickupId: string
}

async function createProject (client: TxOperations, name: string, typeId: Ref<ProjectType>): Promise<Ref<Project>> {
  const projectId = generateId<Project>()
  const projectData = {
    name,
    description: '',
    private: false,
    members: [],
    owners: [],
    archived: false,
    autoJoin: false,
    identifier: 'AAA',
    sequence: 0,
    defaultAssignee: undefined,
    defaultIssueStatus: '' as Ref<IssueStatus>,
    defaultTimeReportDay: TimeReportDayType.PreviousWorkDay
  }
  await client.createDoc(tracker.class.Project, core.space.Space, { ...projectData, type: typeId }, projectId)
  // Add space type's mixin with roles assignments
  await client.createMixin(projectId, tracker.class.Project, core.space.Space, CLICKUP_MIXIN_ID, {})
  return projectId
}

function createClickupProjectType(taskStatuses: string[]): ImportProjectType {
  const statuses = taskStatuses.map((name) => {
    return {
      name
    }
  })
 return {
  name: 'ClickUp project!!!',
  description: 'For issues imported from ClickUp!!!',
  taskTypes: [{
    name: 'ClickUp issue',
    statuses
  }]
 }
}

function createClickupImportWs(taskStatuses: string[]): ImportWorkspace {
  const statuses = taskStatuses.map((name) => {
    return {
      name
    }
  })
 return {
  persons: [],
  spaces: [],
  projectTypes: [{
    name: 'ClickUp project!!!',
    description: 'For issues imported from ClickUp!!!',
    taskTypes: [{
      name: 'ClickUp issue',
      statuses
    }]
  }]
 }
}
