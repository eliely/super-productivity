import { Injectable } from '@angular/core';
import { Observable, of, timer } from 'rxjs';
import { Task } from 'src/app/features/tasks/task.model';
import { catchError, concatMap, first, map, switchMap } from 'rxjs/operators';
import { IssueServiceInterface } from '../../issue-service-interface';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { ProjectService } from '../../../project/project.service';
import { IssueData, SearchResultItem } from '../../issue.model';
import { GitlabCfg } from './gitlab';
import { GitlabIssue } from './gitlab-issue/gitlab-issue.model';
import { truncate } from '../../../../util/truncate';
import {
  GITLAB_BASE_URL,
  GITLAB_INITIAL_POLL_DELAY,
  GITLAB_POLL_INTERVAL,
} from './gitlab.const';
import { isGitlabEnabled } from './is-gitlab-enabled';

@Injectable({
  providedIn: 'root',
})
export class GitlabCommonInterfacesService implements IssueServiceInterface {
  constructor(
    private readonly _gitlabApiService: GitlabApiService,
    private readonly _projectService: ProjectService,
  ) {}

  pollTimer$: Observable<number> = timer(GITLAB_INITIAL_POLL_DELAY, GITLAB_POLL_INTERVAL);

  isBacklogPollingEnabledForProjectOnce$(projectId: string): Observable<boolean> {
    return this._getCfgOnce$(projectId).pipe(
      map((cfg) => this.isEnabled(cfg) && cfg.isAutoAddToBacklog),
    );
  }

  isIssueRefreshEnabledForProjectOnce$(projectId: string): Observable<boolean> {
    return this._getCfgOnce$(projectId).pipe(
      map((cfg) => this.isEnabled(cfg) && cfg.isAutoPoll),
    );
  }

  isEnabled(cfg: GitlabCfg): boolean {
    return isGitlabEnabled(cfg);
  }

  issueLink$(issueId: number, projectId: string): Observable<string> {
    return this._getCfgOnce$(projectId).pipe(
      map((cfg) => {
        if (cfg.gitlabBaseUrl) {
          const fixedUrl = cfg.gitlabBaseUrl.match(/.*\/$/)
            ? cfg.gitlabBaseUrl
            : `${cfg.gitlabBaseUrl}/`;
          return `${fixedUrl}${cfg.project}/issues/${issueId}`;
        } else {
          return `${GITLAB_BASE_URL}${cfg.project?.replace(
            /%2F/g,
            '/',
          )}/issues/${issueId}`;
        }
      }),
    );
  }

  getById$(issueId: number, projectId: string): Observable<GitlabIssue> {
    return this._getCfgOnce$(projectId).pipe(
      concatMap((gitlabCfg) => this._gitlabApiService.getById$(issueId, gitlabCfg)),
    );
  }

  searchIssues$(searchTerm: string, projectId: string): Observable<SearchResultItem[]> {
    return this._getCfgOnce$(projectId).pipe(
      switchMap((gitlabCfg) =>
        gitlabCfg && gitlabCfg.isSearchIssuesFromGitlab
          ? this._gitlabApiService
              .searchIssueInProject$(searchTerm, gitlabCfg)
              .pipe(catchError(() => []))
          : of([]),
      ),
    );
  }

  async getFreshDataForIssueTask(task: Task): Promise<{
    taskChanges: Partial<Task>;
    issue: GitlabIssue;
    issueTitle: string;
  } | null> {
    if (!task.projectId) {
      throw new Error('No projectId');
    }
    if (!task.issueId) {
      throw new Error('No issueId');
    }

    const cfg = await this._getCfgOnce$(task.projectId).toPromise();
    const issue = await this._gitlabApiService.getById$(+task.issueId, cfg).toPromise();

    const issueUpdate: number = new Date(issue.updated_at).getTime();
    const commentsByOthers =
      cfg.filterUsername && cfg.filterUsername.length > 1
        ? issue.comments.filter(
            (comment) => comment.author.username !== cfg.filterUsername,
          )
        : issue.comments;

    // TODO: we also need to handle the case when the user himself updated the issue, to also update the issue...
    const updates: number[] = [
      ...commentsByOthers.map((comment) => new Date(comment.created_at).getTime()),
      issueUpdate,
    ].sort();
    const lastRemoteUpdate = updates[updates.length - 1];

    const wasUpdated = lastRemoteUpdate > (task.issueLastUpdated || 0);

    if (wasUpdated) {
      return {
        taskChanges: {
          ...this.getAddTaskData(issue),
          issueWasUpdated: true,
        },
        issue,
        issueTitle: this._formatIssueTitleForSnack(issue.number, issue.title),
      };
    }
    return null;
  }

  async getFreshDataForIssueTasks(
    tasks: Task[],
  ): Promise<{ task: Task; taskChanges: Partial<Task>; issue: GitlabIssue }[]> {
    // First sort the tasks by the issueId
    // because the API returns it in a desc order by issue iid(issueId)
    // so it makes the update check easier and faster
    tasks.sort((a, b) => +(b.issueId as string) - +(a.issueId as string));
    const projectId = tasks && tasks[0].projectId ? tasks[0].projectId : 0;
    if (!projectId) {
      throw new Error('No projectId');
    }

    const cfg = await this._getCfgOnce$(projectId).toPromise();
    const issues: GitlabIssue[] = [];
    const paramsCount = 59; // Can't send more than 59 issue id For some reason it returns 502 bad gateway
    let ids;
    let i = 0;
    while (i < tasks.length) {
      ids = [];
      for (let j = 0; j < paramsCount && i < tasks.length; j++, i++) {
        ids.push(tasks[i].issueId);
      }
      issues.push(
        ...(await this._gitlabApiService.getByIds$(ids as string[], cfg).toPromise()),
      );
    }

    const updatedIssues: {
      task: Task;
      taskChanges: Partial<Task>;
      issue: GitlabIssue;
    }[] = [];

    for (i = 0; i < tasks.length; i++) {
      const issueUpdate: number = new Date(issues[i].updated_at).getTime();
      const commentsByOthers =
        cfg.filterUsername && cfg.filterUsername.length > 1
          ? issues[i].comments.filter(
              (comment) => comment.author.username !== cfg.filterUsername,
            )
          : issues[i].comments;

      const updates: number[] = [
        ...commentsByOthers.map((comment) => new Date(comment.created_at).getTime()),
        issueUpdate,
      ].sort();
      const lastRemoteUpdate = updates[updates.length - 1];
      const wasUpdated = lastRemoteUpdate > (tasks[i].issueLastUpdated || 0);

      if (wasUpdated) {
        updatedIssues.push({
          task: tasks[i],
          taskChanges: {
            ...this.getAddTaskData(issues[i]),
            issueWasUpdated: true,
          },
          issue: issues[i],
        });
      }
    }
    return updatedIssues;
  }

  getAddTaskData(issue: GitlabIssue): Partial<Task> & { title: string } {
    return {
      title: this._formatIssueTitle(issue.number, issue.title),
      issuePoints: issue.weight,
      issueWasUpdated: false,
      issueLastUpdated: new Date(issue.updated_at).getTime(),
    };
  }

  async getNewIssuesToAddToBacklog(
    projectId: string,
    allExistingIssueIds: number[] | string[],
  ): Promise<IssueData[]> {
    const cfg = await this._getCfgOnce$(projectId).toPromise();
    return await this._gitlabApiService.getProjectIssues$(1, cfg).toPromise();
  }

  private _formatIssueTitle(id: number, title: string): string {
    return `#${id} ${title}`;
  }

  private _formatIssueTitleForSnack(id: number, title: string): string {
    return `${truncate(this._formatIssueTitle(id, title))}`;
  }

  private _getCfgOnce$(projectId: string): Observable<GitlabCfg> {
    return this._projectService.getGitlabCfgForProject$(projectId).pipe(first());
  }
}
