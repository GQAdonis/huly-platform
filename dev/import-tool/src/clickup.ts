import core, {
  type AttachedData,
  type Class,
  collaborativeDocParse,
  generateId,
  makeCollaborativeDoc,
  type Ref,
  type TxOperations
} from '@hcengineering/core'
import { type FileUploader } from './fileUploader'
import document, { type Document, type Teamspace } from '@hcengineering/document'
import tracker from '@hcengineering/tracker'
import pluginState, {
  type Issue,
  IssuePriority,
  type IssueStatus,
  type Project,
  TimeReportDayType
} from '@hcengineering/tracker'
import { jsonToYDocNoSchema, parseMessageMarkdown } from '@hcengineering/text'
import { yDocToBuffer } from '@hcengineering/collaboration'
import { readdir, readFile } from 'fs/promises'
import { join, parse } from 'path'
import csv from 'csvtojson'
import task, { createProjectType, type ProjectType, type Task, type TaskType } from '@hcengineering/task'
import { type ImportIssue } from './importer/importer'

type ClickupId = string
type HulyId = string

interface ClickupTask {
  'Task ID': ClickupId
  'Task Name': string
  'Task Content': string
  'Status': string
  'Parent ID': string
  'Attachments': string[]
  'Assignees': string[]
  'Priority'?: number
  'Space Name': string
  'Checklists': string // todo: obj
  'Comments': string // todo: obj[]
  'Time Estimated': number
  'Time Spent': number
}

const CLICKUP_PROJECT_TYPE_ID = '66f93d911c6b497d54ad5675' as Ref<ProjectType>
const CLICKUP_TASK_TYPE_ID = '66fbf115093abbaab6dd54b7' as Ref<TaskType>
const CLICKUP_MIXIN_ID = `${CLICKUP_TASK_TYPE_ID}:type:mixin` as Ref<Class<Task>>

export async function importClickUp (
  client: TxOperations,
  uploadFile: FileUploader,
  dir: string,
  teamspace: Ref<Teamspace>
): Promise<void> {
  const files = await readdir(dir, { recursive: true })
  console.log(files)

  for (const file of files) {
    const parsedFileName = parse(file)
    const extension = parsedFileName.ext.toLowerCase()
    const fullPath = join(dir, file)
    if (extension === '.md') {
      await processClickupDocument(fullPath, client, uploadFile, parsedFileName.name, teamspace)
    } else if (extension === '.csv') {
      await processClickupTasks(fullPath, client, uploadFile)
    }
  }
}

async function processClickupDocument (
  fullPath: string,
  client: TxOperations,
  uploadFile: (id: string, data: any) => Promise<any>,
  docName: string,
  teamspace: string & {
    __ref: Teamspace
  }
): Promise<void> {
  const data = await readFile(fullPath)
  await importPageDocument(client, uploadFile, docName, data, teamspace)
}

async function processClickupTasks (
  fullPath: string,
  client: TxOperations,
  uploadFile: (id: string, data: any) => Promise<any>
): Promise<void> {
  const jsonArray = await csv().fromFile(fullPath)
  console.log(jsonArray)

  const clickupHulyIdMap = new Map<ClickupId, HulyId>()
  const statuses = new Set<string>()
  const projects = new Set<string>()
  const persons = new Set<string>()
  for (const json of jsonArray) {
    const clickupTask = json as ClickupTask
    console.log(clickupTask)
    clickupHulyIdMap.set(clickupTask['Task ID'], generateId())
    statuses.add(clickupTask.Status)
    projects.add(clickupTask['Space Name'])

    // clickupTask.Assignees.forEach((name) => {
    //   persons.add(name)
    // })
  }
  console.log(clickupHulyIdMap)
  console.log(statuses)
  console.log(projects)
  console.log(persons)

  const projectType = await createClickUpProjectType(client, Array.from(statuses))
  for (const project of projects) {
    createProject(client, project, projectType)
  }
}

function convertToImportIssue (task: ClickupTask): ImportIssue {
  const estimation = task['Time Estimated']
  const remainingTime = estimation - task['Time Spent']
  return {
    title: '[' + task['Task ID'] + '] ' + task['Task Name'],
    description: task['Task Content'],
    assignee: null, // todo
    status: tracker.status.Todo, // todo
    priority: IssuePriority.NoPriority, // todo
    estimation,
    remainingTime
  }
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
  const collabId = makeCollaborativeDoc(id, 'content')
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

  const attachedData: AttachedData<Document> = {
    name,
    content: collabId,
    attachments: 0,
    children: 0,
    embeddings: 0,
    labels: 0,
    comments: 0,
    references: 0
  }

  await client.addCollection(
    document.class.Document,
    space,
    document.ids.NoParent,
    document.class.Document,
    'children',
    attachedData,
    id
  )
}

export interface ClickupIssue extends Issue {
  clickupId: string
}

export async function createClickUpProjectType (
  client: TxOperations,
  statuses: string[]
): Promise<Ref<ProjectType>> {
  return await createProjectType(client, {
    name: 'ClickUp project',
    descriptor: tracker.descriptors.ProjectType,
    shortDescription: 'For issues imported from ClickUp',
    description: '',
    tasks: [],
    roles: 0,
    classic: true
  }, [{
    _id: CLICKUP_TASK_TYPE_ID,
    descriptor: tracker.descriptors.Issue,
    kind: 'both',
    name: 'ClickUp issue',
    ofClass: tracker.class.Issue,
    statusCategories: [task.statusCategory.UnStarted],
    statusClass: tracker.class.IssueStatus,
    icon: tracker.icon.Issue,
    color: 0,
    allowedAsChildOf: [CLICKUP_TASK_TYPE_ID],
    factory: statuses.map(status => {
      return {
        name: status,
        ofAttribute: pluginState.attribute.IssueStatus,
        category: task.statusCategory.UnStarted
      }
    })
  }],
  CLICKUP_PROJECT_TYPE_ID
  )
}

async function createProject (
  client: TxOperations,
  name: string,
  typeId: Ref<ProjectType>
): Promise<Ref<Project>> {
  const projectId = generateId<Project>()
  const projectData = {
    name,
    description: '',
    private: false,
    members: [],
    owners: [],
    archived: false,
    autoJoin: false,
    identifier: 'CLICK',
    sequence: 0,
    defaultAssignee: undefined,
    defaultIssueStatus: '' as Ref<IssueStatus>,
    defaultTimeReportDay: TimeReportDayType.PreviousWorkDay
  }
  await client.createDoc(
    tracker.class.Project,
    core.space.Space,
    { ...projectData, type: typeId },
    projectId
  )
  // Add space type's mixin with roles assignments
  await client.createMixin(
    projectId,
    tracker.class.Project,
    core.space.Space,
    CLICKUP_MIXIN_ID,
    {}
  )
  return projectId
}
