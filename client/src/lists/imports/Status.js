'use strict';

import React, {Component} from 'react';
import PropTypes from 'prop-types';
import {translate} from 'react-i18next';
import {
    requiresAuthenticatedUser,
    Title,
    withPageHelpers
} from '../../lib/page';
import {
    AlignedRow,
    ButtonRow,
    Fieldset
} from '../../lib/form';
import {
    withAsyncErrorHandler,
    withErrorHandling
} from '../../lib/error-handling';
import {getImportTypes} from './helpers';
import {
    prepFinishedAndNotInProgress,
    runInProgress,
    RunStatus,
    runStatusInProgress
} from '../../../../shared/imports';
import {Table} from "../../lib/table";
import {
    Button,
    Icon
} from "../../lib/bootstrap-components";
import axios from "../../lib/axios";
import {getUrl} from "../../lib/urls";
import moment from "moment";
import interoperableErrors from '../../../../shared/interoperable-errors';

@translate()
@withPageHelpers
@withErrorHandling
@requiresAuthenticatedUser
export default class Status extends Component {
    constructor(props) {
        super(props);

        this.state = {
            entity: props.entity
        };

        const {importSourceLabels, importStatusLabels, runStatusLabels} = getImportTypes(props.t);
        this.importSourceLabels = importSourceLabels;
        this.importStatusLabels = importStatusLabels;
        this.runStatusLabels = runStatusLabels;

        this.refreshTimeoutHandler = ::this.periodicRefreshTask;
        this.refreshTimeoutId = 0;
    }

    static propTypes = {
        entity: PropTypes.object,
        list: PropTypes.object
    }

    @withAsyncErrorHandler
    async refreshEntity() {
        const resp = await axios.get(getUrl(`rest/imports/${this.props.list.id}/${this.props.entity.id}`));
        this.setState({
            entity: resp.data
        });
    }

    async periodicRefreshTask() {
        // The periodic task runs all the time, so that we don't have to worry about starting/stopping it as a reaction to the buttons.
        await this.refreshEntity();
        if (this.refreshTimeoutHandler) { // For some reason the task gets rescheduled if server is restarted while the page is shown. That why we have this check here.
            this.refreshTimeoutId = setTimeout(this.refreshTimeoutHandler, 2000);
        }
    }

    componentDidMount() {
        this.periodicRefreshTask();
    }

    componentWillUnmount() {
        clearTimeout(this.refreshTimeoutId);
        this.refreshTimeoutHandler = null;
    }

    async startRunAsync() {
        try {
            await axios.post(getUrl(`rest/import-start/${this.props.list.id}/${this.props.entity.id}`));
        } catch (err) {
            if (err instanceof interoperableErrors.InvalidStateError) {
                // Just mask the fact that it's not possible to start anything and refresh instead.
            } else {
                throw err;
            }
        }

        await this.refreshEntity();

        if (this.runsTableNode) {
            this.runsTableNode.refresh();
        }
    }

    async stopRunAsync() {
        try {
            await axios.post(getUrl(`rest/import-stop/${this.props.list.id}/${this.props.entity.id}`));
        } catch (err) {
            if (err instanceof interoperableErrors.InvalidStateError) {
                // Just mask the fact that it's not possible to stop anything and refresh instead.
            } else {
                throw err;
            }
        }

        await this.refreshEntity();

        if (this.runsTableNode) {
            this.runsTableNode.refresh();
        }
    }

    render() {
        const t = this.props.t;
        const entity = this.state.entity;

        const columns = [
            { data: 1, title: t('Started'), render: data => moment(data).fromNow() },
            { data: 2, title: t('Finished'), render: data => data ? moment(data).fromNow() : '' },
            { data: 3, title: t('Status'), render: data => this.runStatusLabels[data], sortable: false, searchable: false },
            { data: 4, title: t('Processed') },
            { data: 5, title: t('New') },
            { data: 6, title: t('Failed') },
            {
                actions: data => {
                    const actions = [];
                    const status = data[3];

                    let refreshTimeout;

                    if (runStatusInProgress(status)) {
                        refreshTimeout = 1000;
                    }

                    actions.push({
                        label: <Icon icon="eye-open" title={t('Run status')}/>,
                        link: `/lists/${this.props.list.id}/imports/${this.props.entity.id}/status/${data[0]}`
                    });

                    return { refreshTimeout, actions };
                }
            }
        ];

        return (
            <div>
                <Title>{t('Import Status')}</Title>

                <AlignedRow label={t('Name')}>{entity.name}</AlignedRow>
                <AlignedRow label={t('Source')}>{this.importSourceLabels[entity.source]}</AlignedRow>
                <AlignedRow label={t('Status')}>{this.importStatusLabels[entity.status]}</AlignedRow>
                {entity.error && <AlignedRow label={t('Error')}><pre>{entity.error}</pre></AlignedRow>}

                <ButtonRow label={t('Actions')}>
                    {prepFinishedAndNotInProgress(entity.status) && <Button className="btn-primary" icon="play" label={t('Start')} onClickAsync={::this.startRunAsync}/>}
                    {runInProgress(entity.status) && <Button className="btn-primary" icon="stop" label={t('Stop')} onClickAsync={::this.stopRunAsync}/>}
                </ButtonRow>

                <hr/>
                <h3>{t('Import Runs')}</h3>
                <Table ref={node => this.runsTableNode = node} withHeader dataUrl={`rest/import-runs-table/${this.props.list.id}/${this.props.entity.id}`} columns={columns} />
            </div>
        );
    }
}