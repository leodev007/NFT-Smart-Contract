export abstract class Op {
    static transfer  = 0x5fcc3d14;
    static ownership_assigned = 0x05138d91;
    static excesses = 0xd53276db;
    static get_static_data = 0x2fcb26a2;
    static report_static_data = 0x8b771735;
    static get_royalty_params = 0x693d3950;
    static report_royalty_params = 0xa8cb00ad;

    static deploy_item = 1;
    static batch_deploy_item = 2;
    static change_owner = 3;
}

export abstract class Errors {
    static invalid_sender = 401;
    static invalid_index  = 402;
    static invalid_batch_index = 403;

    static invalid_payload = 708;
    static not_enough_gas  = 402;
}
